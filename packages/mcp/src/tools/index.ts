/**
 * Tool registry for the MCP server.
 *
 * This module owns three concerns:
 *   1. The `V01_TOOLS` list — the canonical roster of tool names,
 *      descriptions, and JSON Schema inputs the server advertises via
 *      `tools/list`. The original 10 entries match the Per-tool input
 *      schemas table in `build-mcp-tool/SKILL.md`; v0.2 appends the two
 *      architect-facing semantic-edge tools (`sfi.get_impact` and
 *      `sfi.find_formula_references`); v0.3 appends the developer-facing
 *      `sfi.find_apex_usages` for a total of 13; v1.1 appends
 *      `sfi.why_cant_user_see_record` (the sharing-cascade headline,
 *      14 total); v1.2 appends `sfi.layout_for_user` (the layout-routing
 *      headline, 15 total). The constant name is preserved for ABI
 *      continuity — `@sf-intelligence/mcp`'s barrel re-exports it, and
 *      renaming would break out-of-tree callers.
 *   2. `registerTools` — wires `ListToolsRequestSchema` and
 *      `CallToolRequestSchema` handlers on a `@modelcontextprotocol/sdk`
 *      `Server`. `tools/list` answers with `V01_TOOLS`; `tools/call`
 *      routes by name to `dispatchTool`.
 *   3. `dispatchTool` — the per-tool routing seam. Each tool gets a
 *      `case` that runs its Zod parse, calls its handler, and
 *      serializes the `McpResponse`/`McpError` envelope through
 *      `runTool`.
 *
 * Supersedes the journal-0010 `registerTool` identity stub. Callers that
 * imported `registerTool` / `ToolRegistration` from the barrel now
 * compose tools by appending to `V01_TOOLS` and adding a branch to
 * `dispatchTool`; the barrel re-exports the new shapes in their place.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  EDGE_TYPES,
  type McpError,
  type McpResponse,
} from '@sf-intelligence/contracts';
import type { Result } from '@sf-intelligence/core';
import type { z } from 'zod';

import { auditToolCall } from '../audit.js';
import { instrumentDispatch } from '../observability.js';
import type { Context } from '../server.js';
import { maybeReopenOnEpochChange } from '../server.js';

import {
  annotationsHandler,
  annotationsInputSchema,
  proposeAnnotationHandler,
  proposeAnnotationInputSchema,
} from './annotations.js';
import {
  apexBuildAdvisorHandler,
  apexBuildAdvisorInputSchema,
} from './apex-build-advisor.js';
import {
  apexTestCoverageHandler,
  apexTestCoverageInputSchema,
} from './apex-test-coverage.js';
import {
  appAccessHandler,
  appAccessInputSchema,
} from './app-access.js';
import {
  asyncChainDepthHandler,
  asyncChainDepthInputSchema,
} from './async-chain-depth.js';
import {
  automationBuildAdvisorHandler,
  automationBuildAdvisorInputSchema,
} from './automation-build-advisor.js';
import {
  baselineAcknowledgeHandler,
  baselineAcknowledgeInputSchema,
  baselineStatusHandler,
  baselineStatusInputSchema,
} from './baseline-findings.js';
import {
  blastRadiusLiveHandler,
  blastRadiusLiveInputSchema,
} from './blast-radius-live.js';
import {
  callGraphHandler,
  callGraphInputSchema,
} from './call-graph.js';
import { capabilitiesHandler, capabilitiesInputSchema } from './capabilities.js';
import {
  describeAnalysisHandler,
  describeAnalysisInputSchema,
  listAnalysesHandler,
  listAnalysesInputSchema,
  resolveRunAnalysis,
  runAnalysisInputSchema,
} from './catalog-gateway.js';
import {
  cdcSubscribersHandler,
  cdcSubscribersInputSchema,
} from './cdc-subscribers.js';
import {
  changedSinceHandler,
  changedSinceInputSchema,
} from './changed-since.js';
import {
  codeQualityAuditHandler,
  codeQualityAuditInputSchema,
} from './code-quality-audit.js';
import {
  compareComponentsHandler,
  compareComponentsInputSchema,
} from './compare-components.js';
// v3.1 — cross-org / sandbox-vs-prod comparison tier.
import {
  compareObjectAcrossVaultsHandler,
  compareObjectAcrossVaultsInputSchema,
} from './compare-object-across-vaults.js';
import {
  compareProfileAcrossVaultsHandler,
  compareProfileAcrossVaultsInputSchema,
} from './compare-profile-across-vaults.js';
import {
  compareVaultsHandler,
  compareVaultsInputSchema,
} from './compare-vaults.js';
import {
  componentAsOfHandler,
  componentAsOfInputSchema,
  componentHistoryHandler,
  componentHistoryInputSchema,
} from './component-history.js';
import {
  coverageReportHandler,
  coverageReportInputSchema,
} from './coverage-report.js';
import {
  cpqDependencyMapHandler,
  cpqDependencyMapInputSchema,
} from './cpq-dependency-map.js';
import {
  cpqQuoteTemplateBreakdownHandler,
  cpqQuoteTemplateBreakdownInputSchema,
} from './cpq-quote-template-breakdown.js';
import {
  cpqRuleChainHandler,
  cpqRuleChainInputSchema,
} from './cpq-rule-chain.js';
import {
  crudFlsAuditHandler,
  crudFlsAuditInputSchema,
} from './crud-fls-audit.js';
// v3.2 — OmniStudio composition tier (DataRaptor field-mapping table).
import {
  datatransformFieldMapHandler,
  datatransformFieldMapInputSchema,
} from './datatransform-field-map.js';
// v3.2 — OmniStudio declarative-process tier (DecisionTable browse).
import {
  decisionTableBrowseHandler,
  decisionTableBrowseInputSchema,
} from './decision-table-browse.js';
import {
  diffSnapshotsHandler,
  diffSnapshotsInputSchema,
} from './diff-snapshots.js';
import {
  disambiguateConceptsHandler,
  disambiguateConceptsInputSchema,
} from './disambiguate-concepts.js';
import {
  domainClustersHandler,
  domainClustersInputSchema,
} from './domain-clusters.js';
import {
  downstreamEffectsHandler,
  downstreamEffectsInputSchema,
} from './downstream-effects.js';
import {
  effectivePermissionsHandler,
  effectivePermissionsInputSchema,
} from './effective-permissions.js';
import {
  emptyQueuesAndGroupsHandler,
  emptyQueuesAndGroupsInputSchema,
} from './empty-queues-and-groups.js';
import {
  endpointCatalogHandler,
  endpointCatalogInputSchema,
} from './endpoint-catalog.js';
import {
  eventSubscribersHandler,
  eventSubscribersInputSchema,
} from './event-subscribers.js';
import {
  explainApexMethodHandler,
  explainApexMethodInputSchema,
} from './explain-apex-method.js';
import {
  explainFieldHandler,
  explainFieldInputSchema,
} from './explain-field.js';
import {
  explainFlowHandler,
  explainFlowInputSchema,
} from './explain-flow.js';
import {
  explainFormulaHandler,
  explainFormulaInputSchema,
} from './explain-formula.js';
import {
  exportManifestHandler,
  exportManifestInputSchema,
} from './export-manifest.js';
import {
  field360Handler,
  field360InputSchema,
} from './field-360.js';
import {
  fieldAccessAuditHandler,
  fieldAccessAuditInputSchema,
} from './field-access-audit.js';
import {
  fieldChangeAdvisorHandler,
  fieldChangeAdvisorInputSchema,
} from './field-change-advisor.js';
import {
  fieldLineageHandler,
  fieldLineageInputSchema,
} from './field-lineage.js';
// v3.1 — Q174 honesty-anchor tool.
import {
  fieldMappingBetweenObjectsHandler,
  fieldMappingBetweenObjectsInputSchema,
} from './field-mapping-between-objects.js';
import {
  fieldMeaningHandler,
  fieldMeaningInputSchema,
} from './field-meaning.js';
import {
  fieldProvenanceHandler,
  fieldProvenanceInputSchema,
} from './field-provenance.js';
import {
  findApexUsagesHandler,
  findApexUsagesInputSchema,
} from './find-apex-usages.js';
import {
  findClonePatternsHandler,
  findClonePatternsInputSchema,
} from './find-clone-patterns.js';
import {
  findCodeUsagesHandler,
  findCodeUsagesInputSchema,
} from './find-code-usages.js';
import {
  findComponentUsagesHandler,
  findComponentUsagesInputSchema,
} from './find-component-usages.js';
import {
  findDeadCodeHandler,
  findDeadCodeInputSchema,
} from './find-dead-code.js';
import {
  findDependencyCyclesHandler,
  findDependencyCyclesInputSchema,
} from './find-dependency-cycles.js';
import {
  findFieldAnywhereHandler,
  findFieldAnywhereInputSchema,
} from './find-field-anywhere.js';
import {
  findFormulaReferencesHandler,
  findFormulaReferencesInputSchema,
} from './find-formula-references.js';
import {
  findHardcodedValuesAnywhereHandler,
  findHardcodedValuesAnywhereInputSchema,
} from './find-hardcoded-values-anywhere.js';
import {
  findHardcodedValuesHandler,
  findHardcodedValuesInputSchema,
} from './find-hardcoded-values.js';
import {
  findSemanticFieldHandler,
  findSemanticFieldInputSchema,
} from './find-semantic-field.js';
import {
  fleetDriftRankingHandler,
  fleetDriftRankingInputSchema,
} from './fleet-drift-ranking.js';
import { fleetFindHandler, fleetFindInputSchema } from './fleet-find.js';
import {
  generateAdminHandbookHandler,
  generateAdminHandbookInputSchema,
} from './generate-admin-handbook.js';
import {
  generateArchitectureOverviewHandler,
  generateArchitectureOverviewInputSchema,
} from './generate-architecture-overview.js';
import {
  generateComplianceReportHandler,
  generateComplianceReportInputSchema,
} from './generate-compliance-report.js';
import {
  generateDataDictionaryHandler,
  generateDataDictionaryInputSchema,
} from './generate-data-dictionary.js';
import {
  generateOnboardingDocHandler,
  generateOnboardingDocInputSchema,
} from './generate-onboarding-doc.js';
import {
  generateSharingSummaryHandler,
  generateSharingSummaryInputSchema,
} from './generate-sharing-summary.js';
import {
  getComponentHandler,
  getComponentInputSchema,
} from './get-component.js';
import {
  getEdgesHandler,
  getEdgesInputSchema,
} from './get-edges.js';
import {
  getImpactHandler,
  getImpactInputSchema,
} from './get-impact.js';
import {
  getSubgraphHandler,
  getSubgraphInputSchema,
} from './get-subgraph.js';
import {
  governorLimitRisksHandler,
  governorLimitRisksInputSchema,
} from './governor-limit-risks.js';
import { guidanceHandler, guidanceInputSchema } from './guidance.js';
import {
  healthCheckHandler,
  healthCheckInputSchema,
} from './health-check.js';
import {
  installedPackageCatalogHandler,
  installedPackageCatalogInputSchema,
} from './installed-package-catalog.js';
import {
  integrationMapHandler,
  integrationMapInputSchema,
} from './integration-map.js';
// v3.2 R3 — OmniStudio composer tier.
import {
  integrationProcedureChainHandler,
  integrationProcedureChainInputSchema,
} from './integration-procedure-chain.js';
import {
  lastModifiedHandler,
  lastModifiedInputSchema,
} from './last-modified.js';
import {
  layoutAssignmentsHandler,
  layoutAssignmentsInputSchema,
} from './layout-assignments.js';
import {
  layoutForUserHandler,
  layoutForUserInputSchema,
} from './layout-for-user.js';
import {
  lifecycleProcessHandler,
  lifecycleProcessInputSchema,
} from './lifecycle-process.js';
import {
  lightningPagesHandler,
  lightningPagesInputSchema,
} from './lightning-pages.js';
import {
  listComponentsHandler,
  listComponentsInputSchema,
} from './list-components.js';
import {
  listViewSharingHandler,
  listViewSharingInputSchema,
} from './list-view-sharing.js';
import {
  liveAutomationFiredHandler,
  liveAutomationFiredInputSchema,
} from './live-automation-fired.js';
import {
  liveDriftCheckHandler,
  liveDriftCheckInputSchema,
} from './live-drift-check.js';
import {
  livePicklistUsageHandler,
  livePicklistUsageInputSchema,
} from './live-picklist-usage.js';
import {
  liveConsentHandler,
  liveConsentInputSchema,
  liveCountHandler,
  liveCountInputSchema,
  liveDescribeHandler,
  liveDescribeInputSchema,
  liveEmailTemplateUsageHandler,
  liveEmailTemplateUsageInputSchema,
  liveFieldPopulationHandler,
  liveFieldPopulationInputSchema,
  liveFolderAccessHandler,
  liveFolderAccessInputSchema,
  liveGroupCountHandler,
  liveGroupCountInputSchema,
  liveInactiveUsersHandler,
  liveInactiveUsersInputSchema,
  liveLicenseUsageHandler,
  liveLicenseUsageInputSchema,
  liveOrgHealthHandler,
  liveOrgHealthInputSchema,
  liveOrgLimitsHandler,
  liveOrgLimitsInputSchema,
  liveRecentActivityHandler,
  liveRecentActivityInputSchema,
  liveReportUsageHandler,
  liveReportUsageInputSchema,
  liveSampleHandler,
  liveSampleInputSchema,
  liveStaleCheckHandler,
  liveStaleCheckInputSchema,
  liveAggregateHandler,
  liveAggregateInputSchema,
  liveDuplicateCheckHandler,
  liveDuplicateCheckInputSchema,
  liveOwnerBreakdownHandler,
  liveOwnerBreakdownInputSchema,
  liveStorageByObjectHandler,
  liveStorageByObjectInputSchema,
  liveStaleRecordsHandler,
  liveStaleRecordsInputSchema,
} from './live-plane.js';
import {
  liveBudgetHandler,
  liveBudgetInputSchema,
} from './live-session.js';
import {
  lookupRecordHandler,
  lookupRecordInputSchema,
} from './lookup-record.js';
import {
  getManifestHandler,
  getManifestInputSchema,
} from './manifest.js';
import {
  meaningfulTestAuditHandler,
  meaningfulTestAuditInputSchema,
} from './meaningful-test-audit.js';
import {
  methodReachabilityHandler,
  methodReachabilityInputSchema,
} from './method-reachability.js';
import {
  namingConventionReportHandler,
  namingConventionReportInputSchema,
} from './naming-convention-report.js';
import {
  objectAccessAuditHandler,
  objectAccessAuditInputSchema,
} from './object-access-audit.js';
// v3.2 — OmniStudio (Salesforce Industries) declarative-process tier.
import {
  omniscriptFlowHandler,
  omniscriptFlowInputSchema,
} from './omniscript-flow.js';
import {
  omniuicardWidgetBreakdownHandler,
  omniuicardWidgetBreakdownInputSchema,
} from './omniuicard-widget-breakdown.js';
import {
  orderOfExecutionHandler,
  orderOfExecutionInputSchema,
} from './order-of-execution.js';
import { orgCardHandler, orgCardInputSchema } from './org-card.js';
import { orgDriftBadgeFor } from './org-drift.js';
import {
  orgHistoryHandler,
  orgHistoryInputSchema,
} from './org-history.js';
import {
  orgOverviewHandler,
  orgOverviewInputSchema,
} from './org-overview.js';
import { orgPulseHandler, orgPulseInputSchema } from './org-pulse.js';
import {
  outboundMessageCatalogHandler,
  outboundMessageCatalogInputSchema,
} from './outbound-message-catalog.js';
import {
  packageImpactHandler,
  packageImpactInputSchema,
} from './package-impact.js';
import { hasHandlerCursor } from './page-cursor.js';
import {
  piiInventoryHandler,
  piiInventoryInputSchema,
} from './pii-inventory.js';
import {
  processBuilderMigrationCandidatesHandler,
  processBuilderMigrationCandidatesInputSchema,
} from './process-builder-migration-candidates.js';
import {
  promotionReadinessHandler,
  promotionReadinessInputSchema,
} from './promotion-readiness.js';
import {
  recordtypeAvailabilityHandler,
  recordtypeAvailabilityInputSchema,
} from './recordtype-availability.js';
import { resolveHandler, resolveInputSchema } from './resolve.js';
import {
  retrieveBlindspotReportHandler,
  retrieveBlindspotReportInputSchema,
} from './retrieve-blindspot-report.js';
import {
  routeQuestionHandler,
  routeQuestionInputSchema,
} from './route-question.js';
import {
  safeToDeleteFieldHandler,
  safeToDeleteFieldInputSchema,
} from './safe-to-delete-field.js';
import {
  scheduledJobCatalogHandler,
  scheduledJobCatalogInputSchema,
} from './scheduled-job-catalog.js';
import {
  searchApexSourceHandler,
  searchApexSourceInputSchema,
} from './search-apex-source.js';
import {
  searchComponentsHandler,
  searchComponentsInputSchema,
} from './search-components.js';
import {
  searchFlowMetadataHandler,
  searchFlowMetadataInputSchema,
} from './search-flow-metadata.js';
import {
  churnHandler,
  churnInputSchema,
  trendHandler,
  trendInputSchema,
} from './snapshot-trend.js';
import {
  automationRiskReportHandler,
  automationRiskReportInputSchema,
  fieldCleanupCandidatesHandler,
  fieldCleanupCandidatesInputSchema,
  orgRiskReportHandler,
  orgRiskReportInputSchema,
  permissionRiskReportHandler,
  permissionRiskReportInputSchema,
  releaseReadinessReportHandler,
  releaseReadinessReportInputSchema,
} from './synthesis-reports.js';
import {
  synthesizeAnswerHandler,
  synthesizeAnswerInputSchema,
} from './synthesize-answer.js';
import {
  tabAvailabilityHandler,
  tabAvailabilityInputSchema,
} from './tab-availability.js';
import {
  techDebtScoreHandler,
  techDebtScoreInputSchema,
} from './tech-debt-score.js';
import {
  testCoverageForMethodHandler,
  testCoverageForMethodInputSchema,
} from './test-coverage-for-method.js';
import {
  testCoverageGapsHandler,
  testCoverageGapsInputSchema,
} from './test-coverage-gaps.js';
import {
  testsForChangeHandler,
  testsForChangeInputSchema,
} from './tests-for-change.js';
import { CORE_PROFILE_TOOLS as CORE_TOOLS_SET, toolProfile as resolveToolProfile } from './tool-profile.js';
import {
  unassignedPermissionSetsHandler,
  unassignedPermissionSetsInputSchema,
} from './unassigned-permission-sets.js';
import {
  unusedComponentsHandler,
  unusedComponentsInputSchema,
} from './unused-components.js';
import {
  unusedFieldsDeepHandler,
  unusedFieldsDeepInputSchema,
} from './unused-fields-deep.js';
import {
  userAbilityHandler,
  userAbilityInputSchema,
} from './user-ability.js';
import {
  valueChangeAuditHandler,
  valueChangeAuditInputSchema,
} from './value-change-audit.js';
import {
  whatChangedSinceRefreshHandler,
  whatChangedSinceRefreshInputSchema,
} from './what-changed-since-refresh.js';
import {
  whatHappensOnSaveHandler,
  whatHappensOnSaveInputSchema,
} from './what-happens-on-save.js';
import {
  whatIfChangeFieldTypeHandler,
  whatIfChangeFieldTypeInputSchema,
} from './what-if-change-field-type.js';
import {
  whatIfChangeFieldValueHandler,
  whatIfChangeFieldValueInputSchema,
} from './what-if-change-field-value.js';
import {
  whatIfChangeMethodSignatureHandler,
  whatIfChangeMethodSignatureInputSchema,
} from './what-if-change-method-signature.js';
import {
  whatIfDeactivateFlowHandler,
  whatIfDeactivateFlowInputSchema,
} from './what-if-deactivate-flow.js';
import {
  whatIfDisableTriggerHandler,
  whatIfDisableTriggerInputSchema,
} from './what-if-disable-trigger.js';
import {
  whatIfMakeFieldRequiredHandler,
  whatIfMakeFieldRequiredInputSchema,
} from './what-if-make-field-required.js';
import {
  whatIfMergeProfilesHandler,
  whatIfMergeProfilesInputSchema,
} from './what-if-merge-profiles.js';
import {
  whatIfRemovePicklistValueHandler,
  whatIfRemovePicklistValueInputSchema,
} from './what-if-remove-picklist-value.js';
import {
  whatIfSplitProfileHandler,
  whatIfSplitProfileInputSchema,
} from './what-if-split-profile.js';
import {
  whoCanAccessObjectHandler,
  whoCanAccessObjectInputSchema,
} from './who-can-access-object.js';
import {
  whoCanRunHandler,
  whoCanRunInputSchema,
} from './who-can-run.js';
import {
  whyCantUserSeeRecordHandler,
  whyCantUserSeeRecordInputSchema,
} from './why-cant-user-see-record.js';
import {
  whyFieldChangedHandler,
  whyFieldChangedInputSchema,
} from './why-field-changed.js';

/**
 * One tool's static metadata as advertised to MCP clients.
 *
 *   - `name`: the JSON-RPC tool name the client invokes.
 *   - `description`: a one-line summary the client surfaces to users.
 *   - `inputSchema`: a JSON Schema object describing the tool's input.
 *     v0.1 ships placeholder schemas (`{type: 'object'}`); Phase F's
 *     `mcp-tool-X` tasks replace the entry with the real Zod-derived
 *     JSON Schema.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Concrete JSON Schema for `sfi.search_components`. Hand-authored to mirror
 * `searchComponentsInputSchema` — the project has no zod-to-json-schema
 * dependency, and inlining keeps the advertised schema in lockstep with
 * the Zod validator at code-review time rather than build time.
 */
const SEARCH_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    types: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.capabilities`. The tool takes no arguments;
 * mirrors the empty `z.object({})` validator in its own module.
 */
const CAPABILITIES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.synthesize_answer`. Mirrors
 * `synthesizeAnswerInputSchema`. `input` accepts any JSON (the prior tool
 * output to ground on); `question` and `draft` are optional strings.
 */
const SYNTHESIZE_ANSWER_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      input: {},
      question: { type: 'string' },
      draft: { type: 'string' },
    },
  });

/** Concrete JSON Schema for `sfi.org_pulse`. Mirrors `orgPulseInputSchema`. */
const ORG_PULSE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
});

/** Concrete JSON Schema for `sfi.org_card`. Mirrors `orgCardInputSchema`. */
const ORG_CARD_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/** Concrete JSON Schema for `sfi.list_analyses`. Mirrors `listAnalysesInputSchema`. */
const LIST_ANALYSES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/** Concrete JSON Schema for `sfi.describe_analysis`. Mirrors `describeAnalysisInputSchema`. */
const DESCRIBE_ANALYSIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
  },
  required: ['name'],
});

/** Concrete JSON Schema for `sfi.run_analysis`. Mirrors `runAnalysisInputSchema`. */
const RUN_ANALYSIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    args: {
      description: 'The target analysis args — an object, or a JSON-encoded string of one.',
    },
  },
  required: ['name'],
});

/** Concrete JSON Schema for `sfi.fleet_find`. Mirrors `fleetFindInputSchema`. */
const FLEET_FIND_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['query'],
});

/** Concrete JSON Schema for `sfi.fleet_drift_ranking`. Mirrors `fleetDriftRankingInputSchema`. */
const FLEET_DRIFT_RANKING_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    liveEnabled: { type: 'boolean' },
    vaults: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
});

/**
 * Concrete JSON Schema for `sfi.resolve`. Mirrors `resolveInputSchema` — a
 * non-empty `query`, optional `types` filter, optional `parentId` scope, and
 * a 1..50 `limit`. Drift between Zod and this schema is a code-review concern.
 */
const RESOLVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    types: { type: 'array', items: { type: 'string' } },
    parentId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.get_component`. Mirrors
 * `getComponentInputSchema`; kept inline alongside the search-components
 * schema for the same reason — no zod-to-json-schema dependency, and
 * Zod-vs-advertised drift is easier to spot when both live in this file.
 */
const GET_COMPONENT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    componentId: { type: 'string', minLength: 1 },
    maxBodyBytes: { type: 'integer', minimum: 0, maximum: 30000 },
  },
  required: ['id'],
});

/**
 * Concrete JSON Schema for `sfi.get_edges`. Mirrors `getEdgesInputSchema`.
 * The `edgeType` and `confidence` enums are duplicated from the contracts
 * `EdgeType` and `ConfidenceLevel` unions; the source of truth lives in
 * `get-edges.ts` (Zod) and drift is a code-review concern.
 */
const GET_EDGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    nodeId: { type: 'string', minLength: 1 },
    // 'incoming'/'outgoing' are accepted aliases (normalized to in/out).
    direction: { type: 'string', enum: ['in', 'out', 'both', 'incoming', 'outgoing'] },
    edgeType: {
      type: 'string',
      // Single-sourced from the contracts EDGE_TYPES tuple so the advertised
      // schema can't drift from the Zod enum (both include dispatchesOmniAction).
      enum: [...EDGE_TYPES],
    },
    confidence: {
      type: 'string',
      enum: ['declared', 'parsed', 'heuristic'],
    },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['nodeId'],
});

/**
 * Concrete JSON Schema for `sfi.list_components`. Mirrors
 * `listComponentsInputSchema`. The `type` enum is duplicated from the
 * contracts `ComponentType` union; the source of truth lives in
 * `list-components.ts` (Zod) and any drift between Zod and this schema is
 * a code-review concern.
 */
const LIST_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'CustomObject',
        'CustomField',
        'ValidationRule',
        'Flow',
        'ApexClass',
        'ApexTrigger',
        'Layout',
        'Profile',
        'PermissionSet',
        'PermissionSetAssignment',
        'NamedCredential',
        'ConnectedApp',
        // v1.1 — sharing & visibility tier.
        'Group',
        'Queue',
        'Role',
        'SharingRule',
        // v1.2 — record types + UI surfaces tier.
        'RecordType',
        'BusinessProcess',
        'CustomTab',
        'CustomApplication',
        'QuickAction',
        'PathAssistant',
        'GlobalValueSet',
        'CustomLabel',
        'StaticResource',
        // v1.3 — legacy automation + communications tier.
        'WorkflowRule',
        'ApprovalProcess',
        'AssignmentRule',
        'AutoResponseRule',
        'EscalationRule',
        'DuplicateRule',
        'MatchingRule',
        'EmailTemplate',
        'Letterhead',
        // v1.4 — developer frontend + test mapping tier.
        'LightningComponentBundle',
        'AuraDefinitionBundle',
        'VisualforcePage',
        'VisualforceComponent',
        // v1.5 — integration topology + event/async/API surface tier.
        'AuthProvider',
        'RemoteSiteSetting',
        'CspTrustedSite',
        'ExternalDataSource',
        'ExternalService',
        'NetworkAccess',
        // v1.6 — business-user record-value tier.
        'CustomMetadataRecord',
        'CustomSettingRecord',
        // v2.0a — conditional-context tier.
        'ConditionalContext',
        // v2.8 — async + integration deep tier.
        'OutboundMessage',
        // v3.2 — OmniStudio and decision-table tier.
        'OmniScript',
        'OmniIntegrationProcedure',
        'OmniDataTransform',
        'OmniUiCard',
        'DecisionTable',
        // v4.0 — enterprise safety coverage tier.
        'Report',
        'Dashboard',
        'ListView',
        'ReportType',
        'FlexiPage',
        'PermissionSetGroup',
        'MutingPermissionSet',
        'RestrictionRule',
        'ScopingRule',
      ],
    },
    parentId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
    // P4-interface-impl: ApexClass async/interface/API boolean filters.
    isQueueable: { type: 'boolean' },
    isSchedulable: { type: 'boolean' },
    isBatchable: { type: 'boolean' },
    isRestResource: { type: 'boolean' },
    hasFutureMethod: { type: 'boolean' },
    hasInvocableMethod: { type: 'boolean' },
    hasAuraEnabledMethod: { type: 'boolean' },
    isTest: { type: 'boolean' },
  },
});

/**
 * Concrete JSON Schema for `sfi.get_subgraph`. Mirrors
 * `getSubgraphInputSchema`. The `hops` bounds (`1..3`) are duplicated from
 * the Zod schema in `get-subgraph.ts`; drift between Zod and this schema
 * is a code-review concern.
 */
const GET_SUBGRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    rootId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
  },
  required: ['rootId'],
});

/**
 * Concrete JSON Schema for `sfi.search_apex_source`. Mirrors
 * `searchApexSourceInputSchema`. The `limit` upper bound (`200`) is
 * duplicated from the Zod schema in `search-apex-source.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const SEARCH_APEX_SOURCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    regex: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.search_flow_metadata`. Mirrors
 * `searchFlowMetadataInputSchema`. The shape is identical to
 * `SEARCH_APEX_SOURCE_INPUT_SCHEMA` because the tool inputs are
 * structurally the same; keeping the two constants distinct preserves
 * the one-constant-per-tool symmetry so future Zod-vs-advertised drift
 * is easy to spot at code-review time.
 */
const SEARCH_FLOW_METADATA_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    regex: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['query'],
});

/**
 * Concrete JSON Schema for `sfi.get_naming_convention_report`. Mirrors
 * `namingConventionReportInputSchema` — `scope` is an optional non-empty
 * string; no required fields. The recognizer interprets the value itself
 * (`'all'` or `'CustomField:{ObjectApiName}.*'`); we only enforce
 * non-emptiness at the input boundary so genuinely malformed scopes
 * surface as `invalid-query` further downstream.
 */
const NAMING_CONVENTION_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    scope: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.get_manifest`. The tool takes no arguments;
 * the schema mirrors the empty `z.object({})` validator declared in the
 * tool's own module. Declared as a named constant so the `tools/list`
 * payload stays symmetric with the other tools and Zod-vs-advertised
 * drift remains a code-review concern.
 */
const GET_MANIFEST_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/** Concrete JSON Schema for `sfi.coverage_report`. Mirrors `coverageReportInputSchema`. */
const COVERAGE_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
  },
});

/** Concrete JSON Schema for `sfi.retrieve_blindspot_report`. Mirrors `retrieveBlindspotReportInputSchema`. */
const RETRIEVE_BLINDSPOT_REPORT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    targetType: { type: 'string', minLength: 1 },
    includeLowSignal: { type: 'boolean' },
  },
});

const BASELINE_ACKNOWLEDGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['tool', 'rule', 'componentId', 'location'],
    properties: {
      tool: { type: 'string', minLength: 1 },
      rule: { type: 'string', minLength: 1 },
      componentId: { type: 'string', minLength: 1 },
      location: { type: 'string', minLength: 1 },
      note: { type: 'string' },
    },
  });

const BASELINE_STATUS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      tool: { type: 'string', minLength: 1 },
    },
  });

const TREND_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

const CHURN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    fromLabel: { type: 'string', minLength: 1 },
    toLabel: { type: 'string', minLength: 1 },
  },
});

const LIVE_ENABLED_PROPERTY = {
  liveEnabled: { type: 'boolean' },
  orgAlias: { type: 'string', minLength: 1 },
};

const LIVE_DESCRIBE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_COUNT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  // Either `soql` (a SELECT COUNT() query) or `objectApiName` (count all rows).
  // The one-of requirement is enforced in the handler, not the JSON schema, so
  // the advertised shape stays simple for clients.
  properties: {
    soql: { type: 'string', minLength: 1 },
    objectApiName: { type: 'string', minLength: 1 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STALE_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_SAMPLE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['soql'],
  properties: {
    soql: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_FIELD_POPULATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    required: ['objectApiName', 'fieldApiName'],
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      fieldApiName: { type: 'string', minLength: 1 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

const LIVE_ORG_LIMITS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { ...LIVE_ENABLED_PROPERTY },
});

/** Concrete JSON Schema for `sfi.live_picklist_usage`. Mirrors `livePicklistUsageInputSchema`. */
const LIVE_PICKLIST_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['fieldId'],
});

/** Concrete JSON Schema for `sfi.live_automation_fired`. Mirrors `liveAutomationFiredInputSchema`. */
const LIVE_AUTOMATION_FIRED_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['componentId'],
});

const LIVE_INACTIVE_USERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 3650 },
      includeAllUserTypes: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

/**
 * Concrete JSON Schema for `sfi.live_license_usage`. Mirrors
 * `liveLicenseUsageInputSchema`. `inactiveDays` sets the reclaimable-seat
 * dormancy window (default 90); `limit` caps reclaimable-seat groups. Drift
 * between Zod and this schema is a code-review concern.
 */
const LIVE_LICENSE_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      inactiveDays: { type: 'integer', minimum: 1, maximum: 3650 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      ...LIVE_ENABLED_PROPERTY,
    },
  });

const LIVE_GROUP_COUNT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'groupByField'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    groupByField: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STALE_RECORDS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    dateField: { type: 'string', minLength: 1 },
    includeNeverSet: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_RECENT_ACTIVITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    days: { type: 'integer', minimum: 1, maximum: 365 },
    activity: { type: 'string', enum: ['created', 'modified', 'both'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_AGGREGATE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'fieldApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    fieldApiName: { type: 'string', minLength: 1 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_DUPLICATE_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName', 'fieldApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    fieldApiName: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_OWNER_BREAKDOWN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['objectApiName'],
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filterField: { type: 'string', minLength: 1 },
    filterValue: {},
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_STORAGE_BY_OBJECT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    objectApiNames: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: 80,
    },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_REPORT_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_FOLDER_ACCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    folderType: { type: 'string', enum: ['Report', 'Dashboard', 'Email', 'Document', 'all'] },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_EMAIL_TEMPLATE_USAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    staleDays: { type: 'integer', minimum: 1, maximum: 3650 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_ORG_HEALTH_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    days: { type: 'integer', minimum: 1, maximum: 90 },
    ...LIVE_ENABLED_PROPERTY,
  },
});

const LIVE_CONSENT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    orgAlias: { type: 'string', minLength: 1 },
    grant: { type: 'boolean' },
    revoke: { type: 'boolean' },
  },
});

const ROUTE_QUESTION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', minLength: 1 },
    logGap: { type: 'boolean' },
    clarificationResponse: {
      type: 'object',
      required: ['clarificationId', 'selection'],
      properties: {
        clarificationId: { type: 'string', minLength: 1 },
        selection: { type: 'string', minLength: 1 },
      },
    },
  },
});

const SYNTHESIS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
});

/**
 * Concrete JSON Schema for `sfi.health_check`. The tool takes no arguments;
 * the schema mirrors the empty `z.object({})` validator declared in the
 * tool's own module. Declared as a named constant so the `tools/list`
 * payload stays symmetric with the other tools and Zod-vs-advertised
 * drift remains a code-review concern.
 */
const HEALTH_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.get_impact`. Mirrors
 * `getImpactInputSchema`. The `hops` bounds (`1..3`) and the `edgeTypes`
 * enum are duplicated from `get-impact.ts`; drift between Zod and this
 * schema is a code-review concern. The enum order matches the Zod
 * declaration so a future automated comparison can be a textual diff.
 */
const GET_IMPACT_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
    edgeTypes: {
      type: 'array',
      items: {
        type: 'string',
        // Single-sourced from the contracts EDGE_TYPES tuple (see get_edges).
        enum: [...EDGE_TYPES],
      },
    },
  },
  required: ['componentId'],
});

/** Concrete JSON Schema for `sfi.blast_radius_live`. Mirrors `blastRadiusLiveInputSchema`. */
const BLAST_RADIUS_LIVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    hops: { type: 'integer', minimum: 1, maximum: 3 },
    maxLiveCounts: { type: 'integer', minimum: 0, maximum: 200 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.find_formula_references`. Mirrors
 * `findFormulaReferencesInputSchema`. The `limit` upper bound (`500`) is
 * duplicated from the Zod schema in `find-formula-references.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const FIND_FORMULA_REFERENCES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.find_apex_usages`. Mirrors
 * `findApexUsagesInputSchema`. The `limit` upper bound (`500`) and the
 * `edgeTypes` enum are duplicated from the Zod schema in
 * `find-apex-usages.ts`; drift between Zod and this schema is a
 * code-review concern. The enum is the Apex-emitted subset of the
 * contracts `EdgeType` union.
 */
const FIND_APEX_USAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
      edgeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['readsFrom', 'writesTo', 'callsApex'],
        },
      },
    },
    required: ['targetId'],
  });

/**
 * Concrete JSON Schema for `sfi.find_code_usages`. Mirrors
 * `findCodeUsagesInputSchema`. The `limit` upper bound (`500`), the
 * `edgeTypes` enum (the four code-emitted edge types), and the
 * `nodeTypes` enum (the six code node types — `ApexClass`,
 * `ApexTrigger`, plus the v1.4 frontend tier `LightningComponentBundle`,
 * `AuraDefinitionBundle`, `VisualforcePage`, `VisualforceComponent`)
 * are duplicated from the Zod schema in `find-code-usages.ts`; drift
 * between Zod and this schema is a code-review concern.
 *
 * `references` is included in the `edgeTypes` enum because LWC/Aura/VF
 * extractors emit `references` to other components — the v0.3-era
 * Apex-only enum (`readsFrom`/`writesTo`/`callsApex`) is a strict
 * subset of this one.
 */
const FIND_CODE_USAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
      edgeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['readsFrom', 'writesTo', 'callsApex', 'references'],
        },
      },
      nodeTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'ApexClass',
            'ApexTrigger',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
          ],
        },
      },
    },
    required: ['targetId'],
  });

/**
 * Concrete JSON Schema for `sfi.why_cant_user_see_record`. Mirrors
 * `whyCantUserSeeRecordInputSchema`. JSON Schema cannot express the
 * "at least one userContext field" refine, so callers that supply an
 * empty `userContext` will be rejected at the Zod parse step with
 * `error.kind: 'invalid-query'` rather than at advertised-schema
 * validation. Drift between Zod and this schema is a code-review
 * concern.
 */
/**
 * Concrete JSON Schema for `sfi.effective_permissions`. Mirrors
 * `effectivePermissionsInputSchema` — a profile and/or permission sets
 * (at least one, enforced at the Zod step) plus optional `limit`/`offset`.
 */
const EFFECTIVE_PERMISSIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      profileId: { type: 'string', minLength: 1 },
      permissionSetIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      limit: { type: 'number', minimum: 1, maximum: 200 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.list_view_sharing`. Mirrors
 * `listViewSharingInputSchema` — a required `componentId` (`CustomObject:X`
 * for all of the object's list views, or `ListView:X.Y` for one) plus
 * optional `limit`/`offset` for the paged list-view rows.
 */
const LIST_VIEW_SHARING_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 120 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.who_can_run`. Mirrors `whoCanRunInputSchema` —
 * a required `componentId` (`Flow:X`) plus optional `limit`/`offset`.
 */
const WHO_CAN_RUN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.who_can_access_object`. Mirrors
 * `whoCanAccessObjectInputSchema` — a required `componentId`
 * (`CustomObject:X`) plus optional `limit`/`offset` for the paged
 * granter list.
 */
const WHO_CAN_ACCESS_OBJECT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 250 },
      offset: { type: 'number', minimum: 0 },
    },
    required: ['componentId'],
  });

const WHY_CANT_USER_SEE_RECORD_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    accessLevel: { type: 'string', enum: ['read', 'edit', 'delete', 'create'] },
    userContext: {
      type: 'object',
      properties: {
        profileId: { type: 'string', minLength: 1 },
        permissionSetIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        roleId: { type: 'string', minLength: 1 },
        groupIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
  },
  required: ['componentId', 'userContext'],
});

/**
 * Concrete JSON Schema for `sfi.layout_for_user`. Mirrors
 * `layoutForUserInputSchema`. The three input axes (`objectApiName`,
 * optional `recordTypeId`, `profileId`) are all non-empty strings; no
 * enum constraints since the values are arbitrary Salesforce API
 * names. Drift between Zod and this schema is a code-review concern.
 */
const LAYOUT_FOR_USER_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      recordTypeId: { type: 'string', minLength: 1 },
      profileId: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName', 'profileId'],
  });

/**
 * Concrete JSON Schema for `sfi.layout_assignments`. Mirrors
 * `layoutAssignmentsInputSchema` — a single required `componentId`
 * naming the page Layout (`Layout:{Object}.{LayoutName}`).
 */
const LAYOUT_ASSIGNMENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      limit: { type: 'number', minimum: 1, maximum: 250 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.user_ability`. Mirrors
 * `userAbilityInputSchema` — a required `componentId`
 * (`Profile:X`/`PermissionSet:X`) + optional `limit`/`offset`.
 */
const USER_ABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.lightning_pages`. Mirrors
 * `lightningPagesInputSchema` — a required `componentId`
 * (`CustomObject:X` for the forward, `FlexiPage:X` for the reverse) +
 * optional `limit`/`offset`.
 */
const LIGHTNING_PAGES_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 250 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor (object mode): opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.app_access`. Mirrors `appAccessInputSchema` —
 * a required `componentId` (`CustomApplication:X`) + optional `limit`/`offset`.
 */
const APP_ACCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 250 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.tab_availability`. Mirrors
 * `tabAvailabilityInputSchema` — a required `componentId`
 * (`Profile:X`/`PermissionSet:X`) + optional `limit`/`offset`.
 */
const TAB_AVAILABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 500 },
    offset: { type: 'number', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.lifecycle_process`. Mirrors
 * `lifecycleProcessInputSchema` — a required `objectApiName` plus the optional
 * `field` / `value` transition, an optional `event` (insert|update, default
 * update), and `limit`/`offset` for the paged process chain.
 */
const LIFECYCLE_PROCESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      field: { type: 'string', minLength: 1 },
      value: { type: 'string', minLength: 1 },
      event: { type: 'string', enum: ['insert', 'update'] },
      limit: { type: 'number', minimum: 1, maximum: 200 },
      offset: { type: 'number', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.integration_map`. Mirrors
 * `integrationMapInputSchema`. The `filter` enum is duplicated from
 * the Zod schema in `integration-map.ts` and the `limit` upper bound
 * (`500`) is shared with the other enumeration-style tools. Drift
 * between Zod and this schema is a code-review concern.
 */
const INTEGRATION_MAP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['auth', 'sites', 'sources', 'services', 'access', 'all'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.event_subscribers`. Mirrors
 * `eventSubscribersInputSchema`. The `eventId` suffix constraint
 * (`__e` Platform Event canonical form) is not expressible in JSON
 * Schema, so callers that supply a non-Platform-Event id will be
 * rejected at the handler's `validateEventId` step with
 * `error.kind: 'invalid-query'` rather than at advertised-schema
 * validation. Drift between Zod and this schema is a code-review
 * concern.
 */
const EVENT_SUBSCRIBERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      eventId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.lookup_record`. Mirrors
 * `lookupRecordInputSchema`. The `recordId` prefix constraint
 * (must start with `CustomMetadataRecord:` or `CustomSettingRecord:`)
 * is not expressible in JSON Schema, so callers that supply a non-
 * record id will be rejected at the handler's `classifyRecordId`
 * step with `error.kind: 'invalid-query'` rather than at advertised-
 * schema validation. Drift between Zod and this schema is a code-
 * review concern.
 */
const LOOKUP_RECORD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      recordId: { type: 'string', minLength: 1 },
    },
    required: ['recordId'],
  });

/**
 * Concrete JSON Schema for `sfi.guidance`. Mirrors `guidanceInputSchema`.
 * `topic` is optional — omit to list available knowledge topics.
 */
const GUIDANCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    topic: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.explain_field`. Mirrors
 * `explainFieldInputSchema`. The `fieldId` prefix constraint (must
 * start with `CustomField:`) is not expressible in JSON Schema, so
 * callers that supply a non-CustomField id will be rejected at the
 * handler boundary with `error.kind: 'invalid-query'` rather than at
 * advertised-schema validation. `includeRecordValues` is optional;
 * the handler defaults to true for `__mdt` parents and false
 * otherwise. Drift between Zod and this schema is a code-review
 * concern.
 */
const EXPLAIN_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      includeRecordValues: { type: 'boolean' },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.safe_to_delete_field`. Mirrors
 * `safeToDeleteFieldInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema,
 * so callers that supply a non-CustomField id will be rejected at the
 * handler boundary with `error.kind: 'invalid-query'` rather than at
 * advertised-schema validation. Drift between Zod and this schema is
 * a code-review concern.
 */
const SAFE_TO_DELETE_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['json', 'checklist'] },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.unused_components`. Mirrors
 * `unusedComponentsInputSchema`. The `limit` upper bound (`500`) and
 * the `types` enum are duplicated from the Zod schema in
 * `unused-components.ts`; drift between Zod and this schema is a
 * code-review concern. The enum mirrors the contracts `ComponentType`
 * union — the same superset `LIST_COMPONENTS_INPUT_SCHEMA` uses — so
 * the tool stays usable across every node type the v1.x vault holds.
 */
const UNUSED_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'CustomObject',
            'CustomField',
            'ValidationRule',
            'Flow',
            'ApexClass',
            'ApexTrigger',
            'Layout',
            'Profile',
            'PermissionSet',
            'PermissionSetAssignment',
            'NamedCredential',
            'ConnectedApp',
            'Group',
            'Queue',
            'Role',
            'SharingRule',
            'RecordType',
            'BusinessProcess',
            'CustomTab',
            'CustomApplication',
            'QuickAction',
            'PathAssistant',
            'GlobalValueSet',
            'CustomLabel',
            'StaticResource',
            'WorkflowRule',
            'ApprovalProcess',
            'AssignmentRule',
            'AutoResponseRule',
            'EscalationRule',
            'DuplicateRule',
            'MatchingRule',
            'EmailTemplate',
            'Letterhead',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
            'AuthProvider',
            'RemoteSiteSetting',
            'CspTrustedSite',
            'ExternalDataSource',
            'ExternalService',
            'NetworkAccess',
            'CustomMetadataRecord',
            'CustomSettingRecord',
            // v2.0a — conditional-context tier.
            'ConditionalContext',
            // v2.8 — async + integration deep tier.
            'OutboundMessage',
          ],
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.diff_snapshots`. Mirrors
 * `diffSnapshotsInputSchema`. The `limit` upper bound (`500`) and
 * the `'current'` sentinel for `toLabel` are duplicated from the Zod
 * schema in `diff-snapshots.ts`; drift between Zod and this schema is
 * a code-review concern. JSON Schema cannot express the
 * "must name a persisted snapshot OR equal 'current'" constraint —
 * callers that pass an unknown label surface as `invalid-query` at
 * the handler boundary rather than at advertised-schema validation.
 */
const DIFF_SNAPSHOTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fromLabel: { type: 'string', minLength: 1 },
      toLabel: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['fromLabel', 'toLabel'],
  });

/**
 * Concrete JSON Schema for `sfi.compare_components`. Mirrors
 * `compareComponentsInputSchema`. Both ids are required non-empty
 * strings; the cross-type comparison case (`typesMatch: false`) is
 * intentionally allowed at the schema level so admins can ask
 * "Profile X vs PermissionSet Y" without a workaround. Unknown ids
 * surface as `component-not-found` at the handler boundary.
 */
const COMPARE_COMPONENTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      idA: { type: 'string', minLength: 1 },
      idB: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['json', 'ps-diff'] },
    },
    required: ['idA', 'idB'],
  });

/**
 * Concrete JSON Schema for `sfi.pii_inventory`. Mirrors
 * `piiInventoryInputSchema`. The `classification` and `category`
 * enums (including the `'all'` sentinel that means "no filter") are
 * duplicated from the Zod schema in `pii-inventory.ts`; drift between
 * Zod and this schema is a code-review concern. The `limit` upper
 * bound (`500`) is shared with the other enumeration-style tools.
 */
const PII_INVENTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      classification: {
        type: 'string',
        enum: ['pii', 'sensitive', 'all'],
      },
      category: {
        type: 'string',
        enum: ['identifier', 'contact', 'financial', 'health', 'all'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_access_audit`. Mirrors
 * `fieldAccessAuditInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema,
 * so callers that supply a non-CustomField id are rejected at the
 * handler boundary with `error.kind: 'invalid-query'`. The
 * `permissionType` enum is duplicated from the Zod schema in
 * `field-access-audit.ts`; drift between Zod and this schema is a
 * code-review concern.
 */
const FIELD_ACCESS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      permissionType: {
        type: 'string',
        enum: ['read', 'edit', 'all'],
      },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.object_access_audit`. Mirrors
 * `objectAccessAuditInputSchema`. The `CustomObject:` prefix constraint is
 * enforced at the handler boundary (`invalid-query`), not expressible here.
 */
const OBJECT_ACCESS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.recordtype_availability`. Mirrors
 * `recordtypeAvailabilityInputSchema`. The Profile:/PermissionSet: prefix
 * constraint is enforced at the handler boundary (`invalid-query`).
 */
const RECORDTYPE_AVAILABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.field_360` (v3.0 R4). Mirrors
 * `field360InputSchema`. The `fieldId` accepts either canonical
 * `CustomField:Object.Field` or short `Object.Field` form (the
 * handler normalises); non-matching shapes surface as
 * `invalid-query`. `includeSections` enum mirrors the ten content
 * sections defined in PLAN-v3.0 §4; `maxRowsPerSection` upper bound
 * (`200`) is the Q165 hard cap. Drift between Zod and this schema is
 * a code-review concern.
 */
const FIELD_360_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      includeSections: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'validates',
            'formulas',
            'writers',
            'readers',
            'ui',
            'integrations',
            'automations',
            'emails',
            'dependencies',
            'summary',
          ],
        },
      },
      groupBy: {
        type: 'string',
        enum: ['source', 'edge-type', 'confidence'],
      },
      maxRowsPerSection: { type: 'integer', minimum: 1, maximum: 200 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.field_lineage` (v3.0 R5). Mirrors
 * `fieldLineageInputSchema`. The `direction` enum mirrors the three
 * walk modes; `maxDepth` bounds (`[1, 5]`) duplicate the cap shared
 * with `sfi.call_graph`. `includeFieldsOfTruth` / `includeFiresWhen`
 * default to true at the handler. Drift between Zod and this schema is
 * a code-review concern.
 */
const FIELD_LINEAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      direction: {
        type: 'string',
        enum: ['upstream', 'downstream', 'both'],
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      includeFieldsOfTruth: { type: 'boolean' },
      includeFiresWhen: { type: 'boolean' },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.org_overview`. The tool takes no
 * arguments; the schema mirrors the empty `z.object({})` validator
 * declared in the tool's own module. Declared as a named constant so
 * the `tools/list` payload stays symmetric with the other tools and
 * Zod-vs-advertised drift remains a code-review concern.
 */
const ORG_OVERVIEW_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.domain_clusters`. Mirrors
 * `domainClustersInputSchema`. The `minDensity` bounds (`[0.0, 1.0]`)
 * and the `limit` bounds (`[1, 50]`) are duplicated from the Zod
 * schema in `domain-clusters.ts`; drift between Zod and this schema
 * is a code-review concern. `limit` is constrained to a tighter cap
 * than the enumeration-style tools (50 vs. 500) because the response
 * is a structural summary, not an enumerated list — a caller
 * rendering more than 50 suggested domains is unlikely.
 */
const DOMAIN_CLUSTERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      minDensity: { type: 'number', minimum: 0, maximum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.changed_since`. Mirrors
 * `changedSinceInputSchema`. The `since` ISO-8601 validation is
 * expressed as a non-empty string at the advertised level; the Zod
 * refine (`Date.parse(...)`) rejects non-date strings at the handler
 * boundary with `error.kind: 'invalid-query'`. The `types` enum
 * mirrors the contracts `ComponentType` union, the `limit` upper
 * bound (`500`) is the v1.7 honesty cap, and the schema is the v1.7
 * R2 freshness headline answer to the buyer-priority gap "when was
 * X modified?".
 */
const CHANGED_SINCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      since: { type: 'string', minLength: 1 },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'CustomObject',
            'CustomField',
            'ValidationRule',
            'Flow',
            'ApexClass',
            'ApexTrigger',
            'Layout',
            'Profile',
            'PermissionSet',
            'PermissionSetAssignment',
            'NamedCredential',
            'ConnectedApp',
            'Group',
            'Queue',
            'Role',
            'SharingRule',
            'RecordType',
            'BusinessProcess',
            'CustomTab',
            'CustomApplication',
            'QuickAction',
            'PathAssistant',
            'GlobalValueSet',
            'CustomLabel',
            'StaticResource',
            'WorkflowRule',
            'ApprovalProcess',
            'AssignmentRule',
            'AutoResponseRule',
            'EscalationRule',
            'DuplicateRule',
            'MatchingRule',
            'EmailTemplate',
            'Letterhead',
            'LightningComponentBundle',
            'AuraDefinitionBundle',
            'VisualforcePage',
            'VisualforceComponent',
            'AuthProvider',
            'RemoteSiteSetting',
            'CspTrustedSite',
            'ExternalDataSource',
            'ExternalService',
            'NetworkAccess',
            'CustomMetadataRecord',
            'CustomSettingRecord',
            // v2.8 — async + integration deep tier.
            'OutboundMessage',
          ],
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['since'],
  });

/**
 * Concrete JSON Schema for `sfi.last_modified`. Mirrors
 * `lastModifiedInputSchema`. `componentId` is a non-empty string; the
 * canonical `{Type}:{ApiName}` form is enforced downstream by the
 * graph lookup (an unknown id yields `component-not-found`, not a
 * Zod-level rejection). The v1.7 R3 per-component freshness lookup;
 * the response carries the `enriched: boolean` honesty flag and the
 * verbatim disclosure naming the CLI command to populate missing
 * fields. Drift between Zod and this schema is a code-review concern.
 */
const LAST_MODIFIED_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
    },
    required: ['componentId'],
  });

/**
 * Concrete JSON Schema for `sfi.what_happens_on_save`. Mirrors
 * `whatHappensOnSaveInputSchema`. The `event` enum is duplicated from
 * the Zod schema in `what-happens-on-save.ts` — the source of truth
 * for the enum lives in the Zod validator and drift between Zod and
 * this schema is a code-review concern.
 */
const WHAT_HAPPENS_ON_SAVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      event: {
        type: 'string',
        enum: ['insert', 'update', 'upsert', 'delete', 'undelete'],
      },
      recordTypeId: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName', 'event'],
  });

/**
 * Concrete JSON Schema for `sfi.why_field_changed`. Mirrors
 * `whyFieldChangedInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema,
 * so callers that supply a non-CustomField id will be rejected at the
 * handler boundary with `error.kind: 'invalid-query'`. Drift between
 * Zod and this schema is a code-review concern.
 */
const WHY_FIELD_CHANGED_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.order_of_execution`. Mirrors
 * `orderOfExecutionInputSchema`. The schema takes a single
 * `objectApiName` (non-empty string); the tool emits a per-event
 * tree over the four supported DML events (insert / update / delete
 * / undelete; upsert is excluded as a client-side composition of
 * insert + update).
 */
const ORDER_OF_EXECUTION_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.explain_flow`. Mirrors
 * `explainFlowInputSchema`. The `flowId` prefix constraint (must
 * start with `Flow:`) is not expressible in JSON Schema, so callers
 * that supply a non-Flow id are rejected at the handler boundary
 * with `error.kind: 'invalid-query'`. Drift between Zod and this
 * schema is a code-review concern.
 */
const EXPLAIN_FLOW_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      flowId: { type: 'string', minLength: 1 },
    },
    required: ['flowId'],
  });

/**
 * Concrete JSON Schema for `sfi.explain_apex_method`. Mirrors
 * `explainApexMethodInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query` at the handler boundary. `methodName` is carried
 * verbatim into the response — v2.0f does NOT subset by method (the
 * method-level narrative is deferred to v2.7).
 */
const EXPLAIN_APEX_METHOD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      methodName: { type: 'string', minLength: 1 },
    },
    required: ['classApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.explain_formula`. Mirrors
 * `explainFormulaInputSchema`. The caller must supply EITHER
 * `formulaExpression` (an inline formula string) OR `fieldId` (a
 * canonical CustomField id such as `CustomField:Account.AnnualRevenue__c`).
 * When `fieldId` is supplied the handler resolves the field from the vault
 * graph, extracts its formula expression, and runs the explain logic on it.
 * `parentObjectApiName` is optional and scopes single-segment field
 * references to `CustomField:{parent}.{ref}`; when `fieldId` is used it
 * defaults to the parent object inferred from the id. Invalid formulas
 * surface as a `parseError` field in the response (not an error envelope).
 */
const EXPLAIN_FORMULA_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      formulaExpression: { type: 'string', minLength: 1 },
      fieldId: { type: 'string', minLength: 1 },
      parentObjectApiName: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['json', 'vr-draft'] },
      proposedExpression: { type: 'string', minLength: 1 },
      errorMessage: { type: 'string' },
    },
  });

/**
 * Concrete JSON Schema for `sfi.export_manifest` (P8-manifest-export). Mirrors
 * `exportManifestInputSchema`: a non-empty array of canonical component ids and
 * an optional metadata API version override.
 */
const EXPORT_MANIFEST_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
      },
      apiVersion: { type: 'string', minLength: 1 },
    },
    required: ['componentIds'],
  });

/**
 * Concrete JSON Schema for `sfi.unused_fields_deep`. Mirrors
 * `unusedFieldsDeepInputSchema`. The `limit` upper bound (`500`) is
 * shared with the other enumeration-style tools; the boolean
 * `excludeManagedPackage` / `excludeStandardFields` toggles default to
 * `true` at the handler. `objectId` (added FLD-01) is the primary
 * object-scope parameter; the legacy `parentObjectFilter` (bare api name)
 * remains for back-compat. Drift between Zod and this schema is a code-
 * review concern.
 */
const UNUSED_FIELDS_DEEP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      parentObjectFilter: { type: 'string', minLength: 1 },
      excludeManagedPackage: { type: 'boolean' },
      excludeStandardFields: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.field_cleanup_candidates`. Mirrors
 * `fieldCleanupCandidatesInputSchema`. Extends the generic synthesis schema
 * with optional object-scope parameters: `objectId` (canonical id or bare
 * name) and `objectApiName` (bare name synonym). Drift between Zod and this
 * schema is a code-review concern.
 */
const FIELD_CLEANUP_CANDIDATES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.process_builder_migration_candidates`.
 * Mirrors `processBuilderMigrationCandidatesInputSchema`. The `sortBy`
 * enum and `limit` upper bound are duplicated from the Zod schema;
 * drift is a code-review concern.
 */
const PROCESS_BUILDER_MIGRATION_CANDIDATES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    includeWorkflowRules: { type: 'boolean' },
    includeApprovalProcesses: { type: 'boolean' },
    activeOnly: { type: 'boolean' },
    sortBy: {
      type: 'string',
      enum: ['complexity', 'object', 'name'],
    },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.unassigned_permission_sets`. Mirrors
 * `unassignedPermissionSetsInputSchema`.
 */
const UNASSIGNED_PERMISSION_SETS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    includeManagedPackage: { type: 'boolean' },
    includeMutingPermissionSets: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.installed_package_catalog`. Mirrors
 * `installedPackageCatalogInputSchema` (no input).
 */
const INSTALLED_PACKAGE_CATALOG_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {},
});

/** Concrete JSON Schema for `sfi.annotations`. Mirrors `annotationsInputSchema`. */
const ANNOTATIONS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Narrow to one canonical component id (e.g. `CustomField:Contact.SSN__c`).',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Narrow to one annotation key.',
    },
  },
});

/** Concrete JSON Schema for `sfi.propose_annotation`. Mirrors `proposeAnnotationInputSchema`. */
const PROPOSE_ANNOTATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: {
      type: 'string',
      minLength: 1,
      description: 'Canonical id of the component the proposal is about.',
    },
    key: {
      type: 'string',
      enum: ['owner', 'status', 'glossary', 'domain', 'note'],
      description: 'Annotation key being proposed.',
    },
    value: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Proposed value (e.g. `deprecated`, `RevOps`, a glossary synonym).',
    },
    rationale: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Short reason shown to the confirming human.',
    },
  },
  required: ['componentId', 'key', 'value'],
});

/** Concrete JSON Schema for `sfi.component_history`. Mirrors `componentHistoryInputSchema`. */
const COMPONENT_HISTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1, description: 'Canonical component id.' },
    limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max history entries (default 20).' },
    includeLatestDiff: { type: 'boolean', description: 'Include a capped unified diff of the most recent change.' },
  },
  required: ['componentId'],
});

/** Concrete JSON Schema for `sfi.component_as_of`. Mirrors `componentAsOfInputSchema`. */
const COMPONENT_AS_OF_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1, description: 'Canonical component id.' },
    ref: { type: 'string', minLength: 1, description: 'Git ref in the vault repo (commit hash, HEAD~2, tag).' },
  },
  required: ['componentId', 'ref'],
});

/**
 * Concrete JSON Schema for `sfi.find_component_usages`. Mirrors
 * `findComponentUsagesInputSchema`.
 */
const FIND_COMPONENT_USAGES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    componentId: { type: 'string', minLength: 1 },
    includeGrep: { type: 'boolean' },
    grepLimit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['componentId'],
});

/**
 * Concrete JSON Schema for `sfi.empty_queues_and_groups`. Mirrors
 * `emptyQueuesAndGroupsInputSchema`.
 */
const EMPTY_QUEUES_AND_GROUPS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['Queue', 'Group', 'both'] },
    includeManagedPackage: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.tech_debt_score`. Mirrors
 * `techDebtScoreInputSchema`. The score categories enum and weight
 * bounds are duplicated from the Zod schema; drift is a code-review
 * concern.
 */
const TECH_DEBT_SCORE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      excludeCategories: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'deadWeight',
            'legacyAutomation',
            'codeQuality',
            'freshness',
            'apiVersions',
            'unassignedGrants',
          ],
        },
      },
      weights: {
        type: 'object',
        properties: {
          deadWeight: { type: 'number', minimum: 0, maximum: 1 },
          legacyAutomation: { type: 'number', minimum: 0, maximum: 1 },
          codeQuality: { type: 'number', minimum: 0, maximum: 1 },
          freshness: { type: 'number', minimum: 0, maximum: 1 },
          apiVersions: { type: 'number', minimum: 0, maximum: 1 },
          unassignedGrants: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  });

/**
 * Concrete JSON Schema for `sfi.code_quality_audit`. Mirrors
 * `codeQualityAuditInputSchema`. The `severityFilter` enum mirrors the
 * v2.1 five-tier scale plus the `'all'` sentinel; the `ruleFilter`
 * array of rule ids is open-ended (the v2.1 catalog ships 15 rules but
 * future recognizer additions append without contract changes). The
 * `limit` upper bound (`500`) is shared with the enumeration-style
 * tools. Drift between Zod and this schema is a code-review concern.
 */
const CODE_QUALITY_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      severityFilter: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low', 'info', 'all'],
      },
      ruleFilter: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.governor_limit_risks`. Mirrors
 * `governorLimitRisksInputSchema`. The `limit` upper bound (`500`) is
 * the shared enumeration-style cap; the slice is over classes, not
 * findings. Drift between Zod and this schema is a code-review
 * concern.
 */
const GOVERNOR_LIMIT_RISKS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.find_hardcoded_values`. Mirrors
 * `findHardcodedValuesInputSchema`. The `category` enum mirrors the
 * four hardcoded-literal rule categories (`id` / `email` / `username`
 * / `sandbox-data`); omitted means all four. Drift between Zod and
 * this schema is a code-review concern.
 */
const FIND_HARDCODED_VALUES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['id', 'email', 'username', 'url', 'sandbox-data'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.crud_fls_audit`. Mirrors
 * `crudFlsAuditInputSchema`. The `limit` upper bound (`500`) is the
 * shared enumeration-style cap; the slice is over classes, not
 * findings. Drift between Zod and this schema is a code-review
 * concern.
 */
const CRUD_FLS_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.test_coverage_gaps`. Mirrors
 * `testCoverageGapsInputSchema`. The optional `classFilter` array is
 * capped at 500 items; absent means "scan every non-test ApexClass".
 * Drift between Zod and this schema is a code-review concern.
 */
const TEST_COVERAGE_GAPS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classFilter: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 500,
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.what_if_change_field_value`. Mirrors
 * `whatIfChangeFieldValueInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) surfaces as `invalid-query` at the
 * handler boundary; `newValue` is an optional targeted-check hint.
 */
const WHAT_IF_CHANGE_FIELD_VALUE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      newValue: { type: 'string' },
    },
    required: ['fieldId'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.value_change_audit`. Mirrors
 * `valueChangeAuditInputSchema`. `fields` omitted → auto-detect the
 * value-sensitive fields on `object`.
 */
const VALUE_CHANGE_AUDIT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      object: { type: 'string', minLength: 1 },
      fields: { type: 'array', items: { type: 'string' } },
      verbosity: { type: 'string', enum: ['summary', 'detail'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['object'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.what_if_change_field_type`. Mirrors
 * `whatIfChangeFieldTypeInputSchema`. The `fieldId` prefix constraint
 * (must start with `CustomField:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. The `newType` enum mirrors the v2.3 field-type matrix in
 * `WhatIfSemantics.md` § "Field-type compatibility matrix"; drift
 * between Zod and this schema is a code-review concern.
 */
const WHAT_IF_CHANGE_FIELD_TYPE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      newType: {
        type: 'string',
        enum: [
          'Text',
          'LongTextArea',
          'Number',
          'Currency',
          'Percent',
          'Date',
          'DateTime',
          'Time',
          'Email',
          'Url',
          'Phone',
          'Picklist',
          'MultiselectPicklist',
          'Checkbox',
          'Lookup',
          'MasterDetail',
          'TextArea',
          'EncryptedText',
        ],
      },
    },
    required: ['fieldId', 'newType'],
  });

/**
 * Concrete JSON Schema for `sfi.what_if_remove_picklist_value`. Mirrors
 * `whatIfRemovePicklistValueInputSchema`. The `fieldId` prefix
 * constraint AND the Picklist / MultiselectPicklist type constraint are
 * not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_REMOVE_PICKLIST_VALUE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    value: { type: 'string', minLength: 1 },
  },
  required: ['fieldId', 'value'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_make_field_required`. Mirrors
 * `whatIfMakeFieldRequiredInputSchema`. The `fieldId` prefix constraint
 * is not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_MAKE_FIELD_REQUIRED_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    fieldId: { type: 'string', minLength: 1 },
    ...LIVE_ENABLED_PROPERTY,
  },
  required: ['fieldId'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_deactivate_flow`. Mirrors
 * `whatIfDeactivateFlowInputSchema`. The `flowId` prefix constraint
 * (must start with `Flow:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. Drift between Zod and this schema is a code-review concern.
 */
const WHAT_IF_DEACTIVATE_FLOW_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    flowId: { type: 'string', minLength: 1 },
  },
  required: ['flowId'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_disable_trigger`. Mirrors
 * `whatIfDisableTriggerInputSchema`. The `triggerId` prefix constraint
 * (must start with `ApexTrigger:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. Drift between Zod and this schema is a code-review concern.
 */
const WHAT_IF_DISABLE_TRIGGER_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    triggerId: { type: 'string', minLength: 1 },
  },
  required: ['triggerId'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_change_method_signature`.
 * Mirrors `whatIfChangeMethodSignatureInputSchema`. The `classApiName`
 * prefix constraint (must start with `ApexClass:`) is not expressible
 * in JSON Schema; non-matching prefixes surface as `invalid-query` at
 * the handler boundary. The `newSignature` parameter is optional — when
 * present the tool echoes it verbatim into the response so the renderer
 * can produce before/after output. Drift between Zod and this schema
 * is a code-review concern.
 */
const WHAT_IF_CHANGE_METHOD_SIGNATURE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    classApiName: { type: 'string', minLength: 1 },
    methodName: { type: 'string', minLength: 1 },
    newSignature: { type: 'string' },
  },
  required: ['classApiName', 'methodName'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_merge_profiles`. Mirrors
 * `whatIfMergeProfilesInputSchema`. The `Profile:` prefix constraint
 * is not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. Drift between Zod and this
 * schema is a code-review concern.
 */
const WHAT_IF_MERGE_PROFILES_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileIdA: { type: 'string', minLength: 1 },
    profileIdB: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['profileIdA', 'profileIdB'],
});

/**
 * Concrete JSON Schema for `sfi.what_if_split_profile`. Mirrors
 * `whatIfSplitProfileInputSchema`. The `Profile:` / `PermissionSet:`
 * prefix constraints and the "targets must be PermissionSet" check are
 * not expressible in JSON Schema; non-matching ids surface as
 * `invalid-query` at the handler boundary. The `targetPermSets` array
 * is required to carry at least one entry — the Zod validator enforces
 * this, and the advertised schema mirrors the constraint via
 * `minItems: 1`.
 */
const WHAT_IF_SPLIT_PROFILE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileId: { type: 'string', minLength: 1 },
    targetPermSets: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
    offset: { type: 'integer', minimum: 0 },
    // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
    cursor: { type: 'string', minLength: 1 },
  },
  required: ['profileId', 'targetPermSets'],
});

/**
 * Concrete JSON Schema for `sfi.generate_data_dictionary`. Mirrors
 * `generateDataDictionaryInputSchema`. The `objectId` prefix constraint
 * (must start with `CustomObject:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_DATA_DICTIONARY_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectId: { type: 'string', minLength: 1 },
  },
  required: ['objectId'],
});

/**
 * Concrete JSON Schema for `sfi.generate_admin_handbook`. Mirrors
 * `generateAdminHandbookInputSchema`. The `personaFocus` enum mirrors
 * the four persona values; omitted defaults to `'admin'` at the
 * handler. Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_ADMIN_HANDBOOK_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    personaFocus: {
      type: 'string',
      enum: ['admin', 'architect', 'business-user', 'developer'],
    },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_architecture_overview`. Mirrors
 * `generateArchitectureOverviewInputSchema`: an optional `format`
 * (`'markdown'` default, or `'html'` for a self-contained HTML export).
 * Drift between Zod and this schema is a code-review concern.
 */
const GENERATE_ARCHITECTURE_OVERVIEW_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['markdown', 'html'] },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_sharing_summary`. Mirrors
 * `generateSharingSummaryInputSchema`. `objectFilter` is an optional
 * non-empty string (the api name of a single CustomObject); omitting
 * it scans every extracted object. Drift between Zod and this schema
 * is a code-review concern.
 */
const GENERATE_SHARING_SUMMARY_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectFilter: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.generate_compliance_report`. The tool
 * takes no arguments; the schema mirrors the empty `z.object({})`
 * validator declared in the tool's own module.
 */
const GENERATE_COMPLIANCE_REPORT_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {},
});

/**
 * Concrete JSON Schema for `sfi.generate_onboarding_doc`. Mirrors
 * `generateOnboardingDocInputSchema`. The `personaFocus` enum mirrors
 * the two persona values the v2.5 onboarding-doc generator supports
 * (`'admin' | 'developer'`); omitted defaults to `'admin'` at the
 * handler.
 */
const GENERATE_ONBOARDING_DOC_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    personaFocus: {
      type: 'string',
      enum: ['admin', 'developer'],
    },
  },
});

/**
 * Concrete JSON Schema for `sfi.call_graph`. Mirrors
 * `callGraphInputSchema`. The `rootId` prefix constraint (must start
 * with `ApexClass:` or `ApexTrigger:`) is not expressible in JSON
 * Schema; non-matching prefixes surface as `invalid-query` at the
 * handler boundary. The `direction` enum mirrors the three walk
 * modes and is optional (defaults to `'both'` at the handler); `maxDepth`
 * bounds (`[1, 5]`) are duplicated from the Zod schema in `call-graph.ts`.
 * Drift between Zod and this schema is a code-review concern.
 */
const CALL_GRAPH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      rootId: { type: 'string', minLength: 1 },
      direction: {
        type: 'string',
        enum: ['downstream', 'upstream', 'both'],
      },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      method: { type: 'string', minLength: 1 },
    },
    required: ['rootId'],
  });

/**
 * Concrete JSON Schema for `sfi.downstream_effects`. Mirrors
 * `downstreamEffectsInputSchema`. The `classApiName` prefix constraint
 * (must start with `ApexClass:`, `ApexTrigger:`, or `CustomObject:`) is
 * not expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query` at the handler boundary. `maxDepth` bounds (`[1, 5]`)
 * match the `call_graph` cap. Drift between Zod and this schema is a
 * code-review concern.
 */
const DOWNSTREAM_EFFECTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 5 },
      method: { type: 'string', minLength: 1 },
    },
    required: ['classApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.test_coverage_for_method`. Mirrors
 * `testCoverageForMethodInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query`. `methodName` is optional and echoed verbatim into
 * the response — v2.7 does NOT subset coverage by method (deferred to
 * v2.7.1). Drift between Zod and this schema is a code-review concern.
 */
const TEST_COVERAGE_FOR_METHOD_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    classApiName: { type: 'string', minLength: 1 },
    methodName: { type: 'string', minLength: 1 },
  },
  required: ['classApiName'],
});

/**
 * Concrete JSON Schema for `sfi.meaningful_test_audit`. Mirrors
 * `meaningfulTestAuditInputSchema`. The optional `classFilter` array
 * is capped at 500 items; absent means "audit every test ApexClass".
 * Drift between Zod and this schema is a code-review concern.
 */
const MEANINGFUL_TEST_AUDIT_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    classFilter: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: 500,
    },
  },
});

/**
 * Concrete JSON Schema for `sfi.method_reachability`. Mirrors
 * `methodReachabilityInputSchema`. The `classApiName` prefix
 * constraint (must start with `ApexClass:` or `ApexTrigger:`) is not
 * expressible in JSON Schema; non-matching prefixes surface as
 * `invalid-query`. Drift between Zod and this schema is a code-review
 * concern.
 */
const METHOD_REACHABILITY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
    },
    required: ['classApiName'],
  });

/**
 * Concrete JSON Schema for `sfi.tests_for_change`. Mirrors
 * `testsForChangeInputSchema`. Each `changedComponents` item is an
 * `ApexClass:` / `ApexTrigger:` id or a bare class name; non-Apex `Type:`
 * prefixes bucket into `unsupportedChanges` rather than failing the call.
 * The 1..500 array bound matches `meaningful_test_audit`'s `classFilter`.
 * Drift between Zod and this schema is a code-review concern.
 */
const TESTS_FOR_CHANGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      changedComponents: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 500,
      },
    },
    required: ['changedComponents'],
  });

/**
 * Concrete JSON Schema for `sfi.package_impact`. Mirrors
 * `packageImpactInputSchema`. `namespace` absent → INVENTORY mode; present →
 * IMPACT mode for that managed-package namespace. `limit` caps detail/sample
 * rows. Drift between Zod and this schema is a code-review concern.
 */
const PACKAGE_IMPACT_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      namespace: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.cdc_subscribers`. Mirrors
 * `cdcSubscribersInputSchema`. The optional `sObjectFilter` is a non-
 * empty string; absent means "scan every CDC-recognizable event in
 * the graph". The CDC name-pattern recognition runs inside the
 * handler. Drift between Zod and this schema is a code-review concern.
 */
const CDC_SUBSCRIBERS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      sObjectFilter: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.async_chain_depth`. Mirrors
 * `asyncChainDepthInputSchema`. The `rootApexClassId` prefix
 * constraint (must start with `ApexClass:`) is not expressible in
 * JSON Schema; non-matching prefixes surface as `invalid-query` at
 * the handler boundary. The depth cap (10 hops) is enforced inside
 * the handler. Drift between Zod and this schema is a code-review
 * concern.
 */
const ASYNC_CHAIN_DEPTH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      rootApexClassId: { type: 'string', minLength: 1 },
      rootId: { type: 'string', minLength: 1 },
    },
    minProperties: 1,
  });

/**
 * Concrete JSON Schema for `sfi.scheduled_job_catalog`. The tool
 * takes no arguments; the schema mirrors the empty `z.object({})`
 * validator declared in the tool's own module. Declared as a named
 * constant so the `tools/list` payload stays symmetric with the
 * other tools.
 */
const SCHEDULED_JOB_CATALOG_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {},
  });

/**
 * Concrete JSON Schema for `sfi.outbound_message_catalog`. Mirrors
 * `outboundMessageCatalogInputSchema`. The optional `objectFilter`
 * is a non-empty string; absent means "scan every OutboundMessage in
 * the graph". Drift between Zod and this schema is a code-review
 * concern.
 */
const OUTBOUND_MESSAGE_CATALOG_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectFilter: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.endpoint_catalog`. The tool takes no
 * arguments; the schema mirrors the empty `z.object({})` validator
 * declared in the tool's own module.
 */
const ENDPOINT_CATALOG_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {},
  });

/**
 * Concrete JSON Schema for `sfi.field_meaning` (v2.9 R4). Mirrors
 * `fieldMeaningInputSchema` — `fieldId` is the required CustomField
 * canonical id. Drift between Zod and this schema is a code-review
 * concern.
 */
const FIELD_MEANING_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.disambiguate_concepts` (v2.9 R4).
 * Mirrors `disambiguateConceptsInputSchema` — `conceptA` and
 * `conceptB` are required concept tokens; `limit` is optional and
 * caps each bucket's matchingFields slice. The `200` upper bound is
 * duplicated from `disambiguate-concepts.ts` and is a code-review
 * drift concern.
 */
const DISAMBIGUATE_CONCEPTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      conceptA: { type: 'string', minLength: 1 },
      conceptB: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['conceptA', 'conceptB'],
  });

/**
 * Concrete JSON Schema for `sfi.field_provenance` (v2.9 R4). Mirrors
 * `fieldProvenanceInputSchema` — `fieldId` is the required CustomField
 * canonical id.
 */
const FIELD_PROVENANCE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
    },
    required: ['fieldId'],
  });

/**
 * Concrete JSON Schema for `sfi.find_field_anywhere` (v2.2 R2). Mirrors
 * `findFieldAnywhereInputSchema`. The CustomField id is supplied as
 * `targetId` OR its alias `fieldId` (field-tool-family parity); exactly one
 * is required and must start with `CustomField:` — a missing/empty id or a
 * non-matching prefix surfaces as `invalid-query` at the handler boundary.
 * `limit` defaults to 200 and is capped at 500. `componentTypes` filters the
 * returned references to a subset of ComponentType labels.
 */
const FIND_FIELD_ANYWHERE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      targetId: { type: 'string', minLength: 1 },
      fieldId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      componentTypes: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      // CR-22 continuation cursor: opaque token from a prior page's nextCursor.
      cursor: { type: 'string', minLength: 1 },
    },
    anyOf: [{ required: ['targetId'] }, { required: ['fieldId'] }],
  });

/**
 * Concrete JSON Schema for `sfi.find_semantic_field` (v2.2 R2). Mirrors
 * `findSemanticFieldInputSchema`. `description` is the natural-
 * language concept. `objectIds` optionally filters the candidate
 * field set. `limit` defaults to 10 and is capped at 50; `minScore`
 * defaults to 0.1. Drift between Zod and this schema is a code-review
 * concern.
 */
const FIND_SEMANTIC_FIELD_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      description: { type: 'string', minLength: 1 },
      objectIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      minScore: { type: 'number', minimum: 0, maximum: 1 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    required: ['description'],
  });

/**
 * Concrete JSON Schema for `sfi.find_hardcoded_values_anywhere` (v2.2
 * R2). Mirrors `findHardcodedValuesAnywhereInputSchema`. At least one
 * of `value` / `category` must be supplied (enforced at the handler
 * boundary — JSON Schema cannot express "or"). The `scope` enum
 * narrows the corpora searched; default is all four. `limit` defaults
 * to 100 and is capped at 500.
 */
const FIND_HARDCODED_VALUES_ANYWHERE_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    value: { type: 'string', minLength: 1 },
    query: { type: 'string', minLength: 1 },
    category: {
      type: 'string',
      enum: ['id', 'email', 'date', 'numeric'],
    },
    scope: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['apex', 'formula', 'validation-rule', 'workflow-rule'],
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
    cursor: { type: 'string', minLength: 1 },
  },
});

/**
 * Concrete JSON Schema for `sfi.find_clone_patterns` (v2.2 R2). Mirrors
 * `findClonePatternsInputSchema`. `componentId` is required;
 * non-Apex / non-Flow prefixes surface as `invalid-query` at the
 * handler boundary. `limit` defaults to 10 and is capped at 50;
 * `minScore` defaults to 0.3.
 */
const FIND_CLONE_PATTERNS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      componentId: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: ['ApexClass', 'ApexTrigger', 'Flow'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      minScore: { type: 'number', minimum: 0, maximum: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.find_dead_code` (v2.2 R2). Mirrors
 * `findDeadCodeInputSchema`. `types` is an optional array of
 * ComponentTypes; default is `['ApexClass', 'ApexTrigger', 'Flow',
 * 'CustomField']`. `includeUncertain` defaults to false. `limit`
 * defaults to 100 and is capped at 500.
 */
const FIND_DEAD_CODE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectId: { type: 'string', minLength: 1 },
      objectApiName: { type: 'string', minLength: 1 },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['ApexClass', 'ApexTrigger', 'Flow', 'CustomField'],
        },
      },
      includeUncertain: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.cpq_rule_chain` (v2.6a R2). Mirrors
 * `cpqRuleChainInputSchema` — `ruleId` is the required CPQ rule
 * canonical id. The prefix constraint (`CpqProductRule:` or
 * `CpqPriceRule:`) is not expressible in JSON Schema, so callers that
 * supply a non-rule id are rejected at the handler boundary with
 * `error.kind: 'invalid-query'`. Drift between Zod and this schema is
 * a code-review concern.
 */
const CPQ_RULE_CHAIN_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      ruleId: { type: 'string', minLength: 1 },
    },
    required: ['ruleId'],
  });

/**
 * Concrete JSON Schema for `sfi.cpq_quote_template_breakdown`
 * (v2.6a R2). Mirrors `cpqQuoteTemplateBreakdownInputSchema` —
 * `templateId` is the required CpqQuoteTemplate canonical id. The
 * prefix constraint (`CpqQuoteTemplate:`) is not expressible in JSON
 * Schema; callers with non-CpqQuoteTemplate ids are rejected at the
 * handler boundary. Drift between Zod and this schema is a code-review
 * concern.
 */
const CPQ_QUOTE_TEMPLATE_BREAKDOWN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    templateId: { type: 'string', minLength: 1 },
  },
  required: ['templateId'],
});

/**
 * Concrete JSON Schema for `sfi.cpq_dependency_map` (v2.6a R2).
 * Mirrors `cpqDependencyMapInputSchema` — both fields are optional.
 * When `cpqComponentId` is set, the prefix constraint (any of the five
 * CPQ-typed prefixes) is enforced at the handler boundary because JSON
 * Schema cannot express the union of prefix-string constraints. The
 * `limit` bound (max 200) is duplicated from the Zod schema; drift
 * between Zod and this schema is a code-review concern.
 */
const CPQ_DEPENDENCY_MAP_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      cpqComponentId: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
  });

/**
 * Concrete JSON Schema for `sfi.compare_vaults` (v3.1). Mirrors
 * `compareVaultsInputSchema`. Both alias inputs are required non-empty
 * strings. Optional `objectFilter` / `typeFilter` narrow the diff;
 * `includeVolatileProperties` toggles the v2.0c-inherited noise filter.
 */
const COMPARE_VAULTS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      vaultA: { type: 'string', minLength: 1 },
      vaultB: { type: 'string', minLength: 1 },
      objectFilter: { type: 'string', minLength: 1 },
      typeFilter: { type: 'string', minLength: 1 },
      includeVolatileProperties: { type: 'boolean' },
      format: { type: 'string', enum: ['json', 'markdown'] },
    },
    required: ['vaultA', 'vaultB'],
  });

/** Concrete JSON Schema for `sfi.promotion_readiness`. Mirrors `promotionReadinessInputSchema`. */
const PROMOTION_READINESS_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      sandbox: { type: 'string', minLength: 1 },
      prod: { type: 'string', minLength: 1 },
      typeFilter: { type: 'string', minLength: 1 },
    },
    required: ['sandbox', 'prod'],
  });

/**
 * Concrete JSON Schema for `sfi.compare_object_across_vaults` (v3.1).
 * Mirrors `compareObjectAcrossVaultsInputSchema`.
 */
const COMPARE_OBJECT_ACROSS_VAULTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    objectApiName: { type: 'string', minLength: 1 },
    vaultA: { type: 'string', minLength: 1 },
    vaultB: { type: 'string', minLength: 1 },
    includeVolatileProperties: { type: 'boolean' },
  },
  required: ['objectApiName', 'vaultA', 'vaultB'],
});

/**
 * Concrete JSON Schema for `sfi.compare_profile_across_vaults` (v3.1).
 * Mirrors `compareProfileAcrossVaultsInputSchema`.
 */
const COMPARE_PROFILE_ACROSS_VAULTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    profileName: { type: 'string', minLength: 1 },
    vaultA: { type: 'string', minLength: 1 },
    vaultB: { type: 'string', minLength: 1 },
    includeVolatileProperties: { type: 'boolean' },
  },
  required: ['profileName', 'vaultA', 'vaultB'],
});

/**
 * Concrete JSON Schema for `sfi.field_mapping_between_objects` (v3.1).
 * Mirrors `fieldMappingBetweenObjectsInputSchema`. Single-vault tool —
 * the Q174 honesty anchor surfaces the verbatim heuristic-mapping
 * disclosure on every response.
 */
const FIELD_MAPPING_BETWEEN_OBJECTS_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    vault: { type: 'string', minLength: 1 },
    objectA: { type: 'string', minLength: 1 },
    objectB: { type: 'string', minLength: 1 },
    similarityThreshold: { type: 'number', minimum: 0, maximum: 1 },
    includeTypeIncompatible: { type: 'boolean' },
  },
  required: ['vault', 'objectA', 'objectB'],
});

/**
 * Concrete JSON Schema for `sfi.integration_procedure_chain` (v3.2 R3b).
 * Mirrors `integrationProcedureChainInputSchema`. The
 * `OmniIntegrationProcedure:` prefix constraint is not expressible
 * in JSON Schema, so callers that supply a non-IP id are rejected at
 * the handler boundary with `error.kind: 'invalid-query'`. Drift
 * between Zod and this schema is a code-review concern.
 */
const INTEGRATION_PROCEDURE_CHAIN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    integrationProcedureId: { type: 'string', minLength: 1 },
    includeChildPropertySetConfig: { type: 'boolean' },
  },
  required: ['integrationProcedureId'],
});

/**
 * Concrete JSON Schema for `sfi.omniscript_flow` (v3.2 R3). Mirrors
 * `omniscriptFlowInputSchema`. The `omniScriptId` prefix constraint
 * (must start with `OmniScript:`) is not expressible in JSON Schema;
 * non-matching prefixes surface as `invalid-query` at the handler
 * boundary. `includeChildPropertySetConfig` defaults to false to keep
 * the response compact for the common-case browse use.
 */
const OMNISCRIPT_FLOW_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      omniScriptId: { type: 'string', minLength: 1 },
      includeChildPropertySetConfig: { type: 'boolean' },
    },
    required: ['omniScriptId'],
  });

/**
 * Concrete JSON Schema for `sfi.omniuicard_widget_breakdown` (v3.2
 * R3). Mirrors `omniuicardWidgetBreakdownInputSchema` — the
 * `omniUiCardId` prefix constraint (must start with `OmniUiCard:`)
 * is not expressible in JSON Schema; callers that supply a
 * non-OmniUiCard id are rejected at the handler boundary with
 * `error.kind: 'invalid-query'`. Drift between Zod and this schema
 * is a code-review concern.
 */
const OMNIUICARD_WIDGET_BREAKDOWN_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    omniUiCardId: { type: 'string', minLength: 1 },
  },
  required: ['omniUiCardId'],
});

/**
 * Concrete JSON Schema for `sfi.datatransform_field_map` (v3.2). Mirrors
 * `datatransformFieldMapInputSchema`. The `dataTransformId` prefix
 * constraint (must start with `OmniDataTransform:`) is not expressible
 * in JSON Schema; callers that supply a non-OmniDataTransform id are
 * rejected at the handler boundary with `error.kind: 'invalid-query'`.
 * Drift between Zod and this schema is a code-review concern.
 */
const DATATRANSFORM_FIELD_MAP_INPUT_SCHEMA: Readonly<
  Record<string, unknown>
> = Object.freeze({
  type: 'object',
  properties: {
    dataTransformId: { type: 'string', minLength: 1 },
  },
  required: ['dataTransformId'],
});

/**
 * Concrete JSON Schema for `sfi.decision_table_browse` (v3.2). Mirrors
 * `decisionTableBrowseInputSchema`. The `decisionTableId` prefix
 * constraint (must start with `DecisionTable:`) is not expressible in
 * JSON Schema; callers that supply a non-DecisionTable id are rejected
 * at the handler boundary with `error.kind: 'invalid-query'`. Drift
 * between Zod and this schema is a code-review concern.
 */
const DECISION_TABLE_BROWSE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      decisionTableId: { type: 'string', minLength: 1 },
    },
    required: ['decisionTableId'],
  });

/**
 * The 49 tools the MCP server advertises: the original 10 from v0.1,
 * the two architect-facing semantic-edge tools added in v0.2
 * (`sfi.get_impact` and `sfi.find_formula_references`), the
 * developer-facing `sfi.find_apex_usages` added in v0.3 alongside the
 * heuristic Apex scanner, the admin-facing
 * `sfi.why_cant_user_see_record` headline tool added in v1.1 alongside
 * the sharing & visibility extractors, the v1.2 layout-routing
 * headline `sfi.layout_for_user` added alongside the record-types +
 * UI-surfaces tier, the v1.5 architect integration-topology pair
 * (`sfi.integration_map`, `sfi.event_subscribers`) added alongside the
 * integration-surface and platform-event extractors, the v1.4
 * broadened developer tool `sfi.find_code_usages` added alongside the
 * LWC/Aura/VF frontend extractors (the strict superset of
 * `sfi.find_apex_usages` that also surfaces frontend referrers and the
 * `references` edge type they emit), the v1.6 business-user
 * record-value pair (`sfi.lookup_record`, `sfi.explain_field`) added
 * alongside the CustomMetadataRecord + CustomSettingRecord extractors,
 * the v2.0b buyer-priority composition pair
 * (`sfi.safe_to_delete_field`, `sfi.unused_components`) added as pure
 * compositions over existing edges — no new extractors, no new
 * contracts, no new EdgeTypes — the v2.0c snapshot + diff pair
 * (`sfi.diff_snapshots`, `sfi.compare_components`) added alongside
 * the snapshot CLI infrastructure that answers buyer-priority #8
 * ("what changed in this org since last week?") and #10 ("compare
 * profiles / perm sets / flow versions"), the v2.0d compliance/privacy
 * pair (`sfi.pii_inventory`, `sfi.field_access_audit`) added alongside
 * the `pii-detection` pattern recognizer that answers buyer-priority
 * #5 ("which fields contain PII and who can see/export them?"), and
 * the v2.0g org-tour pair (`sfi.org_overview`, `sfi.domain_clusters`)
 * added as pure compositions over the existing graph queries to
 * answer buyer-priority #9 ("I'm new — give me a tour of this org"),
 * the v2.0e lifecycle-narrator trio
 * (`sfi.what_happens_on_save`, `sfi.why_field_changed`,
 * `sfi.order_of_execution`) added as pure compositions over the
 * v2.0a `firesWhen` ConditionalContext primitive to answer buyer-
 * priority #1 ("why did this field get updated?"), #2 ("what happens
 * when I save this record?"), and #3 ("what's the order of execution
 * for THIS object update in THIS org?"), and the v1.7 R3 per-component
 * freshness tool `sfi.last_modified` added alongside `sfi.changed_since`
 * to complete the freshness tool surface — the per-id sibling of the
 * range-scan tool, both reading the Tooling-API-enriched
 * `properties.lastModifiedDate` / `properties.lastModifiedBy` overlay
 * with backward-compat fallback to the legacy top-level fields.
 * Order is the order they appear in `tools/list` responses; clients
 * should not assume meaning from it but stability is helpful for
 * fixture-based tests. v0.2, v0.3, v1.1, v1.2, v1.4, v1.5, v1.6,
 * v2.0b, v2.0c, v2.0d, v2.0g, and v2.0e entries are appended at the
 * tail so existing fixtures keyed off the prefix continue to match.
 *
 * Per `build-mcp-tool/SKILL.md`, each tool's real input schema is
 * declared in its own `src/tools/{name}.ts` module; this list mirrors
 * those Zod validators as hand-authored JSON Schema constants above.
 *
 * The constant name remains `V01_TOOLS` to preserve the re-export from
 * `src/index.ts`; out-of-tree callers import the symbol by name.
 */
/**
 * Concrete JSON Schema for `sfi.find_dependency_cycles`. Mirrors
 * `findDependencyCyclesInputSchema` in `find-dependency-cycles.ts`; drift
 * between Zod and this schema is a code-review concern.
 */
const FIND_DEPENDENCY_CYCLES_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.apex_test_coverage`. Mirrors
 * `apexTestCoverageInputSchema` in `apex-test-coverage.ts`; drift between Zod
 * and this schema is a code-review concern.
 */
const APEX_TEST_COVERAGE_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      classApiName: { type: 'string', minLength: 1 },
      apexClass: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
      cursor: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.automation_build_advisor`. Mirrors
 * `automationBuildAdvisorInputSchema` in `automation-build-advisor.ts`.
 */
const AUTOMATION_BUILD_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
    },
    required: ['objectApiName'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.apex_build_advisor`. Mirrors
 * `apexBuildAdvisorInputSchema` in `apex-build-advisor.ts`.
 */
const APEX_BUILD_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.field_change_advisor`. Mirrors
 * `fieldChangeAdvisorInputSchema` in `field-change-advisor.ts`.
 */
const FIELD_CHANGE_ADVISOR_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      fieldId: { type: 'string', minLength: 1 },
      newType: { type: 'string', minLength: 1 },
      ...LIVE_ENABLED_PROPERTY,
    },
    required: ['fieldId'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.live_drift_check`. Mirrors
 * `liveDriftCheckInputSchema` in `live-drift-check.ts`.
 */
const LIVE_DRIFT_CHECK_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      objectApiName: { type: 'string', minLength: 1 },
      orgAlias: { type: 'string', minLength: 1 },
      liveEnabled: { type: 'boolean' },
    },
    required: ['objectApiName'],
    additionalProperties: false,
  });

/**
 * Concrete JSON Schema for `sfi.org_history`. Mirrors `orgHistoryInputSchema`
 * in `org-history.ts`.
 */
const ORG_HISTORY_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  });

const WHAT_CHANGED_SINCE_REFRESH_INPUT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

export const V01_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'sfi.search_components',
    description:
      'Free-text search across vault components. Returns ranked matches with snippet previews.',
    inputSchema: SEARCH_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.resolve',
    description:
      "Typo-tolerant resolver: messy/misspelled text -> ranked candidate components with a disposition (exact|ambiguous|none) + per-candidate evidence. Call FIRST when the user names a component informally; tolerates typos, filler, and the org's own misspellings that search_components cannot. CONFIRMED glossary annotations act as curated synonyms (candidates marked `glossary-alias`) — an alias never shadows an exact api-name match, and a synonym shared by two components yields `ambiguous` + clarification. Heuristic; never silently picks.",
    inputSchema: RESOLVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.capabilities',
    description:
      'Product self-description: what this knowledge base can answer. Returns a categorized capability map (with example natural-language questions per area), a `personas` grouping of those categories by role (admin / developer / architect / release-manager / support — each with the relevant `categoryIds` + `questionPaths`, where every path is an operational question plus the ordered `sfi.*` tools that answer it) so you can orient a user by their job and lead with question PATHS rather than a flat tool list, the live registered-tool count, the recommended conversational pattern (call sfi.resolve first; ask a clarifying question on ambiguous; offer /sfi-refresh or stop on none), the three slash commands, the v0.1 read-only/offline boundary, and a `trustGlossary` defining every trust tag a host will see (confidence declared/parsed/heuristic, provenance offline_snapshot/live_org/hybrid, completeness complete/partial/unknown) keyed by the verbatim runtime value. Takes no arguments. Call when the user asks "what can you do / what can I ask?" or to orient a fresh session.',
    inputSchema: CAPABILITIES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_analyses',
    description:
      "Catalog gateway: the paginated index of EVERY analysis this server can run — name, one-line summary, and a coarse category (core / search / what-if / documentation / live / cross-org / industries). Use it to NAVIGATE the roster without loading every schema; then sfi.describe_analysis for one tool's full input schema, and sfi.run_analysis to execute (byte-identical output to a direct call). Optional `category` filter + `limit`/`offset` pagination.",
    inputSchema: LIST_ANALYSES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.describe_analysis',
    description:
      "Catalog gateway: ONE analysis's full description + JSON input schema, fetched on demand (`name`, with or without the `sfi.` prefix). Pair with sfi.list_analyses (find it) and sfi.run_analysis (execute it — byte-identical output to a direct call). Unknown names get an honest invalid-query pointing back at the catalog.",
    inputSchema: DESCRIBE_ANALYSIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.run_analysis',
    description:
      "Catalog gateway: execute any analysis by `name` with `args` (an object, or a JSON-encoded string of one — a known client quirk handled defensively). THIN dispatcher into the same handler table as a direct call: identical payload, byte budget, and trust block — byte-identical output. It cannot dispatch itself, and unknown names return an honest invalid-query with the catalog hint. Use after sfi.list_analyses / sfi.describe_analysis when the full roster is not advertised.",
    inputSchema: RUN_ANALYSIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.synthesize_answer',
    description:
      'Answer-layer grounding pass: turns the JSON returned by prior sfi.* tool call(s) into a structured, citation-grounded answer skeleton — `summary`, `bullets` (headline facts extracted from the input), `citations` (ONLY canonical ids present in the input, parsed to type + apiName), and `caveats` (honesty/limitation strings carried verbatim; an input reduced by the global response byte budget — a `responseBudget` truncation block — becomes an explicit caveat with the dropped/trimmed counts, so a synthesis over truncated data never reads absence as evidence). It also returns a grounded `evidence` skeleton — `finding` → `evidence` (the cited ids) → `likelyCause` → `recommendedFix` → `risk` → `nextAction` — where every field is lifted VERBATIM from the source tool output (a `reason`/`recommendation`/`nextStep`/caveat field) and is `null` when the source carried nothing for it, so the recommended action is never fabricated; `nextAction` falls back to the recommended fix, and `orphanComponentIds` flags any id mentioned inside a cause/fix/next string that is not independently cited (an ungrounded reference). Pass the source tool output as `input` (any JSON), optionally the user `question` (echoed into the summary), and optionally a `draft` narrative — when given, `hallucinatedIds` lists canonical ids in the draft that do NOT appear in the source so they can be removed before answering. `provenance` rolls the source output(s) trust provenance up into `{ stamp, sources }` (`offline_snapshot` / `live_org` / `hybrid` when the input fuses both / `mixed` / `null`) so the host can stamp where the answer came from and never let a vault claim read as a live one. Pure transform: reads ONLY `input`, never the graph or live org, so it can never add a fact it was not handed. Prose wording stays with the caller; this guarantees grounding, not sentences.',
    inputSchema: SYNTHESIZE_ANSWER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.route_question',
    description:
      "Front-door router: for a plain-language question, surface a meaning-ranked shortlist of the sfi.* tools that can answer it — your host LLM picks which to run — plus the plane it belongs to (vault | live | hybrid | unknown), so the user never types a tool name. Read-only; it advises, it does not answer. Compound questions carry step ids and `dependsOn` edges: independent steps may run in parallel; a `then`-linked step waits for its prerequisite. On ambiguity it fails closed with `executionBlocked`, a clarification id, and offered options; resume deterministically by calling again with the exact same question plus `clarificationResponse: { clarificationId, selection }`. Stale ids and invented selections are rejected. Tells you when to sfi.resolve a named component first, whether the opt-in live plane is required, surfaces `suggestedArgs` (heuristic per-intent hints — e.g. `event: 'update'` for a save-order question so you can call `what_happens_on_save` without guessing the DML event), and — when the question hits a capability we lack — returns an honest 'unknown'/gap instead of fabricating (set `logGap: true` to also append the gap to the local backlog; off by default, privacy-first per CR-16); under `SFI_TOOL_PROFILE=core` the response also carries `invoke`: the routed tools as EXECUTABLE calls (core tools direct, everything else as the byte-identical `sfi.run_analysis` gateway envelope, suggestedArgs threaded) (a short phrase that merely NAMES a real vault component, with no question, is instead routed to sfi.resolve rather than 'unknown'). In the default hybrid mode the meaning-ranked `toolCandidates` are PRIMARY: every routable question carries the shortlist (offline TF-IDF over the capability map, no neural model, no network) plus a `guidance` line stating the loop YOU own — read the candidates → resolve any named component → pick/sequence the tool(s) → run them → ground via sfi.synthesize_answer. YOU decide which to run; the deterministic `route` rides along only as a non-authoritative HINT (suggested tool order + any resolved entity / suggestedArgs). Set `SFI_ROUTER_MODE=offline` for a deterministic, no-LLM route (Design A) where the route is authoritative and candidates are omitted — for CI / air-gapped hosts. An optional `mode` ('ask' | 'plan' | 'assessment') tailors the guidance and reranks the candidates toward that mode's family — 'plan' favors the what_if_* / impact tools (an ordered change plan), 'assessment' favors the *_risk_report / readiness / coverage tools (a full evaluation), 'ask' is a quick grounded answer. Call this first on a vague/broad question to decide which tool(s) to run.",
    inputSchema: ROUTE_QUESTION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_pulse',
    description:
      "Org pulse for the current vault: freshness coverage (how many components carry a known lastModifiedDate, the coverage %, and the oldest/newest components) plus the top contributors by lastModifiedBy. Answers \"how fresh is what I know about this org?\" and \"who shaped this org?\". Honesty axis: both signals need lastModifiedDate/By, which a plain `sf project retrieve` does NOT populate — they require a Tooling-API-enriched refresh. ~0% coverage / empty contributors means 'not captured', not 'no history'. Optional `limit` (1..50) caps the lists.",
    inputSchema: ORG_PULSE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_card',
    description:
      'Serve the refresh-time ORG CARD — the ≤16KB orientation snapshot to load BEFORE your first question: identity & freshness, coverage and blind spots up front, scale by type, top objects by inbound dependencies, automation density, permissions posture (incl. god-mode holders), integration surface, observed naming conventions, and how-to-ask rules. Pure cache read of `meta/org-card.json` (rendered once per refresh — never recomputed here), so it costs one file read. A vault refreshed by an older version has no card: returns honest `available: false` with the refresh remedy. No inputs.',
    inputSchema: ORG_CARD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.fleet_find',
    description:
      'Cross-vault resolve: which of your REGISTERED orgs contains the thing you mean. Runs the typo-tolerant resolver across every vault in the multi-vault registry, read-only, and reports per-vault dispositions (exact|ambiguous|none|unavailable) + which vaults it was found in. The cross-org sibling of sfi.resolve. Needs a multi-vault registry (SF_INTELLIGENCE_REGISTRY_PATH, or a registry.json above the vault); a single-vault install gets an honest note instead. Required `query`; optional `limit`.',
    inputSchema: FLEET_FIND_INPUT_SCHEMA,
  },
  {
    name: 'sfi.fleet_drift_ranking',
    description:
      "Fleet ops: of every REGISTERED vault, which is most behind its live org — i.e. which to /sfi-refresh first. Runs the same Tooling-API staleness check as sfi.live_stale_check (components modified since the vault's refreshedAt across ApexClass / ApexTrigger / ValidationRule / Layout / Flow / CustomField) across the whole registry and ranks vaults by drift descending, with a `mostDrifted` + `recommendation`. Consent is PER ORG: a vault whose sourceOrg has no live consent is an honest `no-consent` skip (not an error, no silent call) — grant per org or pass `liveEnabled: true`. Every query routes through the per-session live-query budget, so a sweep the budget can't cover degrades to `budget-exhausted` skips instead of overrunning org API limits (raise SFI_LIVE_QUERY_BUDGET or pass a `vaults` subset). Each ranked row is its own live_org read at its own time; the aggregate is a fleet roll-up (one org's freshness never implies another's). Only the 6 checked types drift-count; read-only. Optional `vaults` (alias subset), `liveEnabled`.",
    inputSchema: FLEET_DRIFT_RANKING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_component',
    description:
      'Fetch a single component by canonical id. Returns its frontmatter and a response-safe Markdown body slice; large bodies are truncated with explicit bodyBytes/returnedBodyBytes/omittedBodyBytes metadata. Optional maxBodyBytes (0..30000) narrows the body slice. A PHANTOM id (referenced by retrieved metadata but never itself retrieved) returns component-not-found with a classified reference stub — and an AUTOMATION-CRITICAL phantom hit is also queued in meta/demand-queue.jsonl so `sfi refresh --drain-demand-queue` (or the watch daemon with --drain-demand-queue) can pull exactly the components real questions needed.',
    inputSchema: GET_COMPONENT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_components',
    description:
      'List components of a given type (optionally narrowed by parentId), sorted by id. Paginated via limit/offset; `hasMore` hints at additional pages (a truncated page returns a `nextCursor` to resume). For `type: \'ApexClass\'`, optional boolean filters list interface/async/API implementers at the DB layer (correct pagination, not a post-filtered page): `isBatchable` / `isQueueable` / `isSchedulable` / `isRestResource` / `hasFutureMethod` / `hasInvocableMethod` / `hasAuraEnabledMethod` / `isTest` — e.g. `{ type: \'ApexClass\', isBatchable: true }` returns every Batchable class. When manifest coverage for the requested `type` is not `complete`, a structured `coverageCaveat` flags the inventory as potentially incomplete (scoped refresh, errored retrieve, not modeled) — including on non-empty pages. When the FIRST page is empty, a `retrievalHint` (FRESH-02) says WHY — "none in the org" (retrieved, none found) vs "not retrieved" (a scoped refresh skipped the type — run /sfi-refresh) vs "not modeled" — so an empty list is never a silent `[]` read as "the org has none". (The hint is suppressed when a boolean filter is active, since an empty filtered result is not a coverage gap.)',
    inputSchema: LIST_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_edges',
    description:
      "List edges incident to a node, optionally filtered by direction, edge type, and confidence. Paginated: `limit` (default 200, max 1000) and `offset` (default 0) page through the edges, with `totalCount` (the unpaged total), `hasMore`, and `nextOffset` to advance — so a hub node (e.g. a standard object with thousands of `grantedBy` FLS edges) returns a usable page instead of tripping the ~45 KB response limit. A per-response ~38 KB byte budget trims the page further (with a `note`) when wide edges would still overflow; filter by `edgeType`/`direction`/`confidence` to narrow.",
    inputSchema: GET_EDGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_subgraph',
    description:
      'BFS from a root component, up to `hops` (max 3). Returns the connected node and edge slice.',
    inputSchema: GET_SUBGRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.search_apex_source',
    description:
      'Search the vaulted Apex source for matches. Optional regex; returns path, line, and snippet.',
    inputSchema: SEARCH_APEX_SOURCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.search_flow_metadata',
    description:
      'Search the vaulted Flow metadata XML for matches. Optional regex; returns path, line, and snippet.',
    inputSchema: SEARCH_FLOW_METADATA_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_naming_convention_report',
    description:
      'Return the naming-convention pattern observations, optionally scoped to a glob.',
    inputSchema: NAMING_CONVENTION_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_manifest',
    description:
      'Return the current vault manifest (org-kb/meta/manifest.json) verbatim.',
    inputSchema: GET_MANIFEST_INPUT_SCHEMA,
  },
  {
    name: 'sfi.coverage_report',
    description:
      "Report the vault's self-assessed metadata coverage: covered, partial, not-modeled, and — during a staged refresh — pending families (queued by the in-progress tiered build, with `stagedBuild` tier progress; pending types count as missing coverage, so absence answers about them must stay qualified). Use before absence-based or destructive answers.",
    inputSchema: COVERAGE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.retrieve_blindspot_report',
    description:
      "Retrieve blind spots: components REFERENCED by retrieved automation / code / config but ABSENT from the vault (their edge targets resolve to no node — the last refresh never pulled them). The honest backing for absence answers: an 'X is unused / nothing references X / X is safe to delete' answer about a listed target is unreliable. The `blindspots` list is the high-signal class — automation/code/integration references (triggersOn an unretrieved object, callsApex an unretrieved class, sendsEmail an unretrieved template) — grouped by target type, each tagged with its coverage status (notModeled / absent = a whole-type manifest gap; covered = specific managed/community components outside the retrieve scope) and a concrete `remedy`. Permission-set grants (the managed/standard 'grant-only' class), layout field decoration, and unresolved Apex-scanner phantoms are rolled up as counts (low analysis impact) — pass `includeLowSignal: true` to enumerate them. `cleanVault: true` and an empty `blindspots` means every reference resolves. Optional `targetType` narrows to one type. Provenance offline_snapshot. Lookup / master-detail relationship targets pointing at an unretrieved object are included (dangling `lookupTo` edges).",
    inputSchema: RETRIEVE_BLINDSPOT_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.health_check',
    description:
      'Report self-assessed server health, render consistency, and coverage completeness, plus a freshness block (vault age, a stale flag, the most recent refresh\'s change count, and a yellow-flag nudge when the vault is old or local source drifted). While a staged refresh (`sfi refresh --staged`) is mid-build, status is degraded with explicit tier progress ("building tier i/n") until the final tier clears the marker.',
    inputSchema: HEALTH_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.baseline_acknowledge',
    description:
      'Acknowledge a heuristic finding so SAST tools suppress it across refreshes (stored in org-kb/meta/baseline.json).',
    inputSchema: BASELINE_ACKNOWLEDGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.baseline_status',
    description:
      'List suppressed finding fingerprints and per-tool counts from the vault baseline file.',
    inputSchema: BASELINE_STATUS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_describe',
    description:
      'Opt-in live org: describe an sObject via Salesforce CLI. Disabled unless SFI_LIVE_PLANE_ENABLED=1 or liveEnabled=true. Read-only; provenance live_org.',
    inputSchema: LIVE_DESCRIBE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_stale_check',
    description:
      "Opt-in live org (P5-stale-detection): \"is the org AHEAD of the vault?\". For each Tooling-queryable type (ApexClass, ApexTrigger, ValidationRule, Layout, Flow, CustomField), counts components with `LastModifiedDate` AFTER the vault's `refreshedAt` via the Tooling API. Returns `orgAheadOfVault`, `totalChangedSinceRefresh`, per-type `byType`, `checkedTypes`, `erroredTypes`, and an `interpretation`. A non-zero total means the vault is STALE relative to the org — run /sfi-refresh. Read-only; does not mutate the org or vault. Requires the live plane (SFI_LIVE_PLANE_ENABLED, liveEnabled:true, or sfi.live_consent). orgAheadOfVault:false means \"none of the CHECKED types drifted\", not \"nothing changed\".",
    inputSchema: LIVE_STALE_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_count',
    description:
      'Opt-in live org: count records. Pass `objectApiName` to count every row of an object, or `soql` for a custom SELECT COUNT() query (strict shape validation). Read-only; never falls back to vault data.',
    inputSchema: LIVE_COUNT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_sample',
    description:
      'Opt-in live org: run SOQL with a hard row cap (default + max 200). Read-only sample rows for runtime questions. The caller controls the projection, so a per-response ~36 KB byte budget also trims trailing rows when a wide SELECT (e.g. FIELDS(STANDARD)) at the row cap would exceed the global ~45 KB response limit — `rowCount` reflects the rows actually returned and a `note` appears when rows were dropped for size (narrow the SELECT or lower `limit` to sample more).',
    inputSchema: LIVE_SAMPLE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_field_population',
    description:
      'Opt-in live org: population rate for one field (total vs null counts). Read-only.',
    inputSchema: LIVE_FIELD_POPULATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_group_count',
    description:
      'Opt-in live org: value distribution — COUNT grouped by one field on any object (e.g. Cases by Status, Accounts by Industry). Optional equality filter. Read-only; capped buckets; provenance live_org.',
    inputSchema: LIVE_GROUP_COUNT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_stale_records',
    description:
      'Opt-in live org: records on any object not touched in N days (default LastModifiedDate). Answers "which X are stale/unused?" without arbitrary SOQL. Read-only; reports true total plus capped detail rows.',
    inputSchema: LIVE_STALE_RECORDS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_recent_activity',
    description:
      'Opt-in live org: records created or modified in the last N days on any object. Read-only; capped detail with true total.',
    inputSchema: LIVE_RECENT_ACTIVITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_aggregate',
    description:
      'Opt-in live org: MIN/MAX/AVG/SUM on one numeric field for any object. Optional equality filter. Read-only; provenance live_org.',
    inputSchema: LIVE_AGGREGATE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_duplicate_check',
    description:
      'Opt-in live org: find duplicate values on one field (GROUP BY + HAVING COUNT > 1). Read-only; capped duplicate groups.',
    inputSchema: LIVE_DUPLICATE_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_owner_breakdown',
    description:
      'Opt-in live org: record counts by OwnerId with User/Queue names resolved. Read-only; top owners by volume.',
    inputSchema: LIVE_OWNER_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_storage_by_object',
    description:
      'Opt-in live org: record counts across objects via the Salesforce recordCount REST API — top N by volume, optional objectApiNames filter. Read-only.',
    inputSchema: LIVE_STORAGE_BY_OBJECT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_org_limits',
    description:
      'Opt-in live org: current org governor limits via REST. Read-only.',
    inputSchema: LIVE_ORG_LIMITS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_inactive_users',
    description:
      "Opt-in live org: active users who haven't logged in within N days (default 30) or never have — the license-reclamation / dormant-account question. Standard (human) users by default; reports the true total (`totalInactive`) plus a capped detail page, oldest-dormant first. `limit` pages the detail rows (default 100, hard cap 500) and a per-response ~36 KB byte budget trims the page further when a wide page would exceed it (the response carries both the structured rows and a rendered table, so it can't trip the global ~45 KB limit); `capped` flips true when more remain and a `note` appears when the page was byte-trimmed. Read-only; LastLoginDate is live-only state.",
    inputSchema: LIVE_INACTIVE_USERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_license_usage',
    description:
      "Opt-in live org: license / cost optimization. Returns UserLicense and PermissionSetLicense utilization (total / used / available / utilizationPct; unlimited licenses surface total: -1 → available/pct null) plus `reclaimableSeats` — active Standard users dormant past `inactiveDays` (default 90), grouped by their user license, the paid-seats-nobody-uses question. Honesty axis (verbatim): reclaimable seats is a PROXY (inactivity, not actual feature usage; some dormant seats are held intentionally; per-feature-license usage is not covered). READ-ONLY: never deprovisions or reassigns a license — verify each seat before reclaiming. License counts and LastLoginDate are live-only state.",
    inputSchema: LIVE_LICENSE_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_consent',
    description:
      "Manage one-time, per-org consent for the read-only live plane. Default (no args) REPORTS whether live is enabled for the org and which orgs are consented — it never silently enables anything. grant: true records standing consent so future sessions can run sfi.live_* without re-asking; revoke: true removes it. Granting writes only a LOCAL user-level preference — it never reads or writes the Salesforce org. This is the explicit opt-in the live tools require; call it (with grant: true) after the user agrees to enable live answers for their org.",
    inputSchema: LIVE_CONSENT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_report_usage',
    description:
      'Opt-in live org: stale/unused reports via Report.LastRunDate — total vs not-run-in-N-days. Read-only; resilient when Report is unavailable. Fails CLOSED without the live plane: with no consent (SFI_LIVE_PLANE_ENABLED=1, liveEnabled:true, or sfi.live_consent) it returns a clear invalid-query error and never queries the org.',
    inputSchema: LIVE_REPORT_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_folder_access',
    description:
      'Opt-in live org: folder inventory and access types (Report/Dashboard/Email/Document). Read-only; flags publicly accessible folders.',
    inputSchema: LIVE_FOLDER_ACCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_email_template_usage',
    description:
      'Opt-in live org: email template usage, Classic vs Lightning classification, and migration candidates. Read-only.',
    inputSchema: LIVE_EMAIL_TEMPLATE_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_org_health',
    description:
      'Opt-in live org: operational health snapshot — failed/pending async jobs, paused flow interviews, governor limits at risk. Read-only.',
    inputSchema: LIVE_ORG_HEALTH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_automation_fired',
    description:
      "P6-live-automation-fired (HYBRID, HEURISTIC): does this record-triggered automation actually run in production? Given an ApexTrigger / record-triggered Flow / WorkflowRule `componentId`, resolves its trigger object (the vault `triggersOn` edge) and, when the live plane is enabled, checks whether that object has records and whether any were modified in the last `staleDays` (default 90). Flags `likelyNeverRuns: true` when the trigger object has ZERO records (cannot have fired) or has records but NONE changed in the window (a create/change-triggered automation hasn't fired recently). `confidence: 'heuristic'` — record presence/activity is necessary but NOT sufficient (entry criteria may filter every record; execution itself is not observed without debug logs). Non-record-triggered automation (autolaunched/scheduled/screen flows, platform-event subscribers) is reported `applicable: false`. WITHOUT consent it returns the resolved trigger object + a caveat (offline_snapshot). Counts only; provenance hybrid when consented.",
    inputSchema: LIVE_AUTOMATION_FIRED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_picklist_usage',
    description:
      "P6-live-picklist-usage (HYBRID): which picklist VALUES are actually used in production. Given a Picklist/MultiselectPicklist `CustomField:{Object}.{Field}` id, runs a live `GROUP BY` over the field's value distribution and cross-references it against the vault's DEFINED value set: returns `usage` (each value with its live record count, top-N), `unusedDefinedValues` (values the picklist defines that NO record uses — cleanup / restrict-to-active candidates), `undefinedUsedValues` (values records carry that the picklist no longer defines), and `blankCount`. Honest empty when the object has no records or the field is never populated. WITHOUT consent it returns the DEFINED values with a caveat (offline_snapshot) — the value set still answers, usage just isn't filled in. provenance hybrid when consented. Counts only; for a MultiselectPicklist per-value counts overlap (a record counts toward every value in its combo) — flagged. `limit` caps distinct values (default 50).",
    inputSchema: LIVE_PICKLIST_USAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_budget',
    description:
      "P6-live-budget-guard: disclose this session's live-query budget and result-cache state. Returns `budget` (limit/used/remaining — the per-session cap, default 50 via SFI_LIVE_QUERY_BUDGET, that stops the hybrid plane from exhausting org API limits), `cache` (cached-result count + TTL), and — when the live plane is enabled — `orgApiHeadroom` cross-checked against the org's real DailyApiRequests via `sf org limits` so the cap is visibly a tiny fraction of what the org can serve. Budget/cache are SESSION-LOCAL runtime state, reported without a live call (no consent needed); only the org-headroom cross-check needs the live plane. A repeated identical live query is served from cache and costs NO budget. Read-only.",
    inputSchema: LIVE_ORG_LIMITS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_risk_report',
    description:
      'Deterministic org risk synthesis: health, tech debt, and coverage gaps ranked with trust metadata.',
    inputSchema: SYNTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_cleanup_candidates',
    description:
      "Ranked unused-field cleanup candidates composed from sfi.unused_fields_deep. Optional `objectId` narrows the scan to one CustomObject — accepts the canonical id (`CustomObject:Account`) or a bare api name (`Account`); without it the scan is org-wide. `limit` (default 100, max 500) caps the candidates; because each carries the full eight-tier detail, a per-response ~36 KB byte budget trims the list further when it would exceed the global ~45 KB MCP response limit, adding a `note` (use sfi.unused_fields_deep, paginated, for the full detail).",
    inputSchema: FIELD_CLEANUP_CANDIDATES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.automation_risk_report',
    description:
      'Ranked automation risks: Process Builder migration candidates and governor-limit findings.',
    inputSchema: SYNTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.permission_risk_report',
    description:
      "Ranked permission-risk report, leading with OVER-PRIVILEGE read straight from the extracted profile / permission-set metadata: every Profile or PermissionSet that grants a god-mode or administrative system permission (Modify All Data / View All Data = critical; Author Apex, Customize Application, Manage Users, Manage Profiles/PermSets, Modify Metadata, Manage Sharing, Manage Roles, password/login policies = high) OR object-level View All / Modify All, surfaced as ONE aggregated finding per grantor (severity = the worst signal; system perms + a per-grantor count of objects escalated). PermissionSetGroups are analysed too: a PSG's effective god-mode is aggregated from its MEMBER permission sets (so a user who gets Modify All Data via a group is caught), with the muting permission set noted but not subtracted (v1 honesty boundary). A `privilege` block rosters the `modifyAllDataGrantors` / `viewAllDataGrantors` (profiles, permission sets, AND groups) and the `overPrivilegedGrantorCount`. Also rolls in unassigned permission sets and CRUD/FLS audit totals. Answers 'who has god mode / Modify All / View All / who is an admin / who is over-permissioned'. Read-only, declared confidence (literal metadata flags, not heuristics); `limit` (default 50) caps the findings. When the vault holds a captured permission-holder aggregate, the god-mode grantors carry active-holder counts via a `dataShape` holders block (`data_snapshot`, counts only) — a god-mode permission set held by 40 active users outranks one held by none.",
    inputSchema: SYNTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.release_readiness_report',
    description:
      'Release readiness gate composed from org risk and coverage completeness.',
    inputSchema: SYNTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.get_impact',
    description:
      'BFS over incoming edges from a component, up to `hops` (max 3). Returns the slice of nodes and edges that depend on the target — "what breaks if I change this?". Carries a `soundness` envelope (`complete` / `blindSpots[]` / `staticCoverage`): `complete: false` with a `dynamic-apex` blind spot listing any impacted class that builds references at runtime (dynamic SOQL / reflective describe / Type.forName / untyped JSON), so the result is never implied complete when static analysis is blind.',
    inputSchema: GET_IMPACT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.blast_radius_live',
    description:
      "P6-blast-radius-live (HYBRID ⭐): fuse the static impact graph with LIVE record magnitude — \"what breaks if I change/remove X, and how much is at stake?\". Takes the `get_impact` slice for a CustomField/CustomObject and, when the live plane is enabled, pairs every record-bearing dependency with a live COUNT (a CustomField → non-null record count, a CustomObject → total rows; e.g. \"847 records hold a non-null value\"). Code/config dependencies (Flow, Apex, validation rules, layouts, permissions) are listed WITHOUT a count — they break too, but \"records affected\" is not their unit. Leads with a vault-staleness warning when the org is ahead of the vault, stamps `provenance: 'hybrid'` carrying both planes' freshness, and routes every live query through the session cache + per-session budget. WITHOUT consent it returns the full static impact with a caveat (provenance offline_snapshot) — the static answer is never blocked on the live plane. Counts only; never reads or stores a record row. `maxLiveCounts` caps live queries per call (default 25).",
    inputSchema: BLAST_RADIUS_LIVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_formula_references',
    description:
      'List the incoming `references` edges to a field with the source nodes and edge-level metadata (e.g., formula tokenizer properties).',
    inputSchema: FIND_FORMULA_REFERENCES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_apex_usages',
    description:
      'List the Apex source files (classes and triggers) that read, write, or call into a component. Filters incoming `readsFrom`/`writesTo`/`callsApex` edges to those originating from `ApexClass:*` or `ApexTrigger:*` nodes. `boundaries[]` carries the heuristic disclosure; an empty result adds an empty≠absent line (cross-check `find_component_usages`), never a silent empty.',
    inputSchema: FIND_APEX_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.effective_permissions',
    description:
      "Compute a user's EFFECTIVE access — the UNION of a profile + assigned permission sets, max-wins, with each permission attributed to the container(s) that grant it. `why_cant_user_see_record` evaluates a single record question against a bundle; nothing else rolls the containers up into one combined ability — this does. Input: `profileId` and/or `permissionSetIds[]` (at least one). A `PermissionSetGroup:` id may be passed in `permissionSetIds[]` — it is EXPANDED into its member permission sets (declared membership) and unioned in, so a PSG-assigned user gets a real answer (a permset reachable both directly and via a group is unioned once, not double-counted). It composes each container's outgoing `grantedBy` edges (object + field + apex) and `properties.userPermissions` (system perms). `objectPermissions[]` carries the OR'd `allowCreate`/`allowRead`/`allowEdit`/`allowDelete`/`viewAllRecords`/`modifyAllRecords` per object plus `grantedBy` (the containers contributing a flag); `systemPermissions[]` lists each user-permission with its `grantedBy`; `customPermissions[]` (CR-CAP-10) lists each granted custom permission with its `grantedBy` + `targetMissing` (true when the granted name has no `CustomPermission` definition in the vault — managed-package / not-retrieved; declared but not resolvable, and NOT folded into systemPermissions); `summary` reports objects / fieldsWithFls / apexClasses / systemPermissions / customPermissions counts. The object list PAGES (`limit` default 100 / max 200, `offset`/`hasMore`/`truncated`). `declared` confidence. `disclosures` is explicit about the boundaries: permission-set GROUP membership IS expanded, but muting permission sets are DISCLOSED, not subtracted (effective access may be lower); app/tab visibility is a SEPARATE surface (now extracted — see `app_access` / `tab_availability`), not part of this union; field-level detail is summarised (use `field_access_audit`); object permission is NOT record access (record visibility needs OWD + sharing); custom permissions are declared grants, NOT system userPermissions, so they are never double-counted. Missing containers are ignored with a disclosure; if none exist → `component-not-found`.",
    inputSchema: EFFECTIVE_PERMISSIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.who_can_run',
    description:
      "The REVERSE of `sfi.user_ability`: given a `Flow:X` (`componentId`), which Profiles / PermissionSets grant RUN access to it (from the `flowAccess` `grantedBy` edges). `granters[]` = `{granterId, granterType, granterLabel}`, paginated; `summary.granters` is the total. `declared` confidence. `boundaryNote`: a user gains it only when ASSIGNED the container (runtime), and run needs the flow active; \"who can OPEN an app\" is `app_access` (applicationVisibilities, not a grantedBy edge); report/dashboard FOLDER access needs the live plane (folder shares aren't in the offline metadata). Phantom-aware (a flow referenced only by run grants is still answerable). Unknown flow with no run grant → `component-not-found`; non-`Flow:` prefix → `invalid-query`.",
    inputSchema: WHO_CAN_RUN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.who_can_access_object',
    description:
      "The REVERSE of `sfi.why_cant_user_see_record`: given a `CustomObject:X` (`componentId`), ENUMERATE which profiles / permission sets / roles / groups statically gain access to that object's records, and how. Sources: (1) OWD — a public org-wide default (`owdGrantsAllInternalUsers: true`) means every internal user reads/edits every record; (2) object permissions — Profiles/PermissionSets whose `grantedBy` edge carries `allowRead`/`allowCreate`/`allowEdit`/`allowDelete` (each CRUD bit enumerated INDEPENDENTLY — records visible per OWD+sharing) or `viewAllRecords`/`modifyAllRecords` (ALL records); (3) system god-mode — `ViewAllData`/`ModifyAllData`; (4) sharing rules — the `sharedWith` role/group targets of the object's owner & criteria rules (criteria rules cite the predicate); a shared GROUP target is expanded through `hasMember` (CR-CAP-12) so each member it contains — transitively through nested groups — is also listed as its own granter row (a dangling member like a Territory is listed but flagged unresolved). Each `granters[]` row has `via` (e.g. `object-permission-read`/`-create`/`-edit`/`-delete`, `view-all-object`/`modify-all-object`, `system-*`, `owner-`/`criteria-sharing-rule`), `access` (`read`/`create`/`edit`/`delete`/`all`), and `scope` (`all-records` vs `shared-records`). Because CRUD bits are orthogonal, ONE principal can emit several rows (each independently addressable by `granterId|via`): `summary.total` is the ROW count, `summary.distinctGranters` is the ACTOR count — count principals by the latter. `summary` also tallies all/shared (COMPLETE), and the list PAGES (`limit` default 120 / max 250, `offset`/`hasMore`/`truncated`). `declared` confidence. `blindSpots` discloses what a STATIC view cannot enumerate — record ownership + the role hierarchy above each owner, which records match a criteria predicate, manual/Apex-managed sharing, account-teams, and sharing sets — so absence is never overstated. When the object carries RestrictionRules, an extra blind spot + a per-row caveat on the god-mode granters disclose that ANY row (View/Modify All Data included) can be narrowed at runtime — mirroring `why_cant_user_see_record`'s `unknown` god-mode verdict on such objects. `scanTruncated: true` (with a `boundaryNote`) when a Profile/PermissionSet/SharingRule scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`), so a very large org's enumeration is disclosed as possibly incomplete rather than implied complete. Unknown object → `component-not-found`; a non-`CustomObject:` prefix → `invalid-query`. When the vault holds a captured permission-holder aggregate, each Profile/PermissionSet granter on the page also carries 'held by N active users' via a `dataShape` holders block (`data_snapshot`, counts only, stamped).",
    inputSchema: WHO_CAN_ACCESS_OBJECT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.why_cant_user_see_record',
    description:
      "Walk the Salesforce sharing cascade (OWD → PermissionGrant → SystemPermission → RoleHierarchy → OwnerSharingRule → CriteriaSharingRule → RestrictionRule → ScopingRule → TerritoryAndGuestRules → ManualSharing → SharingSets → AccountTeams) for a given object and a user's access bundle. TWO-PLANE access model: seeing a record needs BOTH (A) object-level READ CRUD (from the profile UNION any assigned permission set, or system View/Modify All Data — Edit/Delete/Create all imply Read) AND (B) record-level access. Plane A is a PRECONDITION evaluated first: a user with NO object Read is `restricted` regardless of OWD (a Public-Read OWD does NOT make a record visible to a zero-permission user), and plain object Edit/Delete is NOT a record-visibility grant — on a Private object it satisfies only the precondition, so record access still depends on OWD/sharing. Plane B is granted by: object View All / Modify All records (`viewAllRecords`/`modifyAllRecords`, the only object-perm record-sharing BYPASS), system `ViewAllData`/`ModifyAllData` (god-mode bypass), a public OWD on top of the satisfied precondition, ownership, or a sharing grant. FLS (field-level security) is irrelevant to record visibility and never enters the verdict. The TerritoryAndGuestRules stage now ENUMERATES the object's attached guest / territory / territoryGroup sharing rules (CR-CAP-16): each surfaces its declared detail — id, accessLevel, Experience-Cloud site name (guest) or shared target (territory), and predicate — but the verdict stays `unknown` because applicability is record-level (existence is declarable, the share decision is not); when none attach, a single `unknown` step preserves the not-modeled disclosure (absence is never \"no access\"). Owner-rule GROUP targets are also expanded through `hasMember` (CR-CAP-12) so a user in a NESTED public group matches a rule that grants the enclosing group. Optional `accessLevel` (`'read'` default | `'edit'` | `'delete'` | `'create'`) picks the operation: `edit` needs a ReadWrite OWD (with object Edit precondition) or object Modify-All / ModifyAllData record bypass (a read-only path is NOT edit-capable; plain object Edit on a Private object only meets the precondition); `delete` needs FullAccess OWD / ModifyAll / ownership (sharing rules and ViewAllData never grant delete) — so this answers \"who can edit/delete this record\", not just view. `create` is a SEPARATE model that does NOT flow through OWD / sharing / role hierarchy (you don't need to see existing records to create one): it short-circuits the cascade and is `visible` only when the user has object Create permission (`allowCreate` or object/system Modify-All) AND — if the object has record types — at least one VISIBLE record type (a `RecordType` stage reads `recordTypeVisibilities`; the record-type gate is ANDed onto the permission gate, so a Create grant with no visible record type is `restricted`). So this also answers \"who can create a record of this object\". REQUIRED params: `componentId` (the object/record component, e.g. `CustomObject:Account`) and `userContext` — an object describing the user's access bundle that must carry AT LEAST ONE of `profileId`, `permissionSetIds` (string[]), `roleId`, `groupIds` (string[]); an empty `userContext` is rejected with `invalid-query`. A `PermissionSetGroup:` id may be passed in `permissionSetIds[]` — it is EXPANDED into its member permission sets (declared membership) and folded into the user's context, so a PSG-assigned user gets a REAL verdict from the grant cascade rather than `unknown`; the `PermissionSetGroup` reasoning step reports how many groups were expanded and notes any muting permission set (muting is DISCLOSED, never subtracted). Returns a structured reasoning chain and an aggregate verdict (visible / restricted / unknown). Stages whose answer the v1.1 metadata model cannot decide report `unknown` with an explanation — when object Read is present but only unmodeled sharing (manual / teams / sets / ControlledByParent's master sharing) could grant access, the honest verdict is `unknown`, never a flat `restricted`. Offline/vault tool — it does NOT read live user assignments; pass the user's profile/permission-set/role/group ids yourself.",
    inputSchema: WHY_CANT_USER_SEE_RECORD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.layout_for_user',
    description:
      "Walk the Salesforce layout-routing cascade (ProfileLookup → LayoutAssignment → RecordTypeResolution) for a given object, optional record type, and profile. Returns the resolved layout id (or null), the record type the cascade ended up using, and a structured reasoning trail. When the Profile node does not yet carry extracted `layoutAssignments` data (the v0.1 extractor's honesty boundary), the cascade reports `unknown` with an explanation rather than fabricating.",
    inputSchema: LAYOUT_FOR_USER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.user_ability',
    description:
      "\"What can this Profile / PermissionSet RUN or DO?\" — beyond record CRUD (which `object_access_audit` / `why_cant_user_see_record` cover). Given a `Profile:X` or `PermissionSet:X` (`componentId`): `runnableFlows` (the `Flow:` ids the container grants run access to, via the `flowAccess` grantedBy edges, paginated); `loginRestrictions` (`ipRangeCount` + `loginHoursRestricted` — Profile-only, `applies:false` for a permission set); `actionPermissions` (the run/export/transfer/convert/mass-edit class of system permissions present, filtered from `userPermissions`); and `customPermissions` (CR-CAP-10 — the custom permissions the container CONFERS via its `<customPermissions>` grants, each with `targetMissing` when the granted name has no `CustomPermission` definition in the vault; custom permissions are NOT system userPermissions, so they are not double-counted with actionPermissions). `summary` tallies runnableFlows + actionPermissions + customPermissions. `declared` confidence. `boundaryNote`: the user must be ASSIGNED the container to gain these (runtime, not modeled), and flow run access also needs the flow active. `flowAccess` grant edges are extracted at every refresh (PermissionSet `<flowAccesses>`); a vault refreshed before that extraction reports no runnable flows — re-run `/sfi-refresh` rather than reading it as a verified empty. Unknown id → `component-not-found`; non-Profile/PermissionSet prefix → `invalid-query`.",
    inputSchema: USER_ABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lightning_pages',
    description:
      "Lightning record pages (FlexiPage), both directions. Given a `CustomObject:X` (`componentId`) it returns the Lightning pages FOR that object (`pages[]` of `{flexiPageId, masterLabel, pageType}`, from the `flexiPageObject` `references` edges, paginated); given a `FlexiPage:X` it returns that page's `forObject` / `pageType` / `masterLabel`. `declared` confidence. CRITICAL honesty axis (`activationDisclosure`, always present): which profile / record type / app / form factor ACTIVATES (is served) a page is NOT in the retrieved FlexiPage metadata — it is a separate Lightning App Builder assignment — so this reports the pages that EXIST for an object, NOT which one a given user sees (`layout_for_user` covers CLASSIC layouts). Unknown id → `component-not-found`; a non-`CustomObject:`/`FlexiPage:` prefix → `invalid-query`.",
    inputSchema: LIGHTNING_PAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.list_view_sharing',
    description:
      "\"Who is this list view shared with?\" — a list view's `<sharedTo>` visibility scope (the groups/roles it shows up for in the list-view picker), now captured at extraction as `visibleTo` edges. Two modes via `componentId`: a `CustomObject:X` returns ALL of the object's list views (`listViews[]`, paginated via `limit`/`offset`), a `ListView:X.Y` returns that one. Each row: `componentId` (the ListView id), `apiName`, `filterScope` (Everything/Mine/Queue/…), `visibility` (`sharedWithGroupsRoles` | `allUsersWithObjectAccess`), `sharedToCount`, and `sharedTo[]` of `{type,name,targetId,inheritance?,synthetic?}` (Group/Role targets; `roleAndSubordinates` carries an `inheritance` marker; synthetic groups like AllInternalUsers carry `synthetic`). `summary` tallies listViews / sharedWithGroupsRoles / allUsersWithObjectAccess / distinctTargets. `declared` confidence. CRITICAL honesty axis (`boundaryNote`, always present): this is visibility of the saved VIEW, NOT record access — a user still needs read access to the object (use `object_access_audit` / `why_cant_user_see_record`) and the records must pass the view's filter; `filterScope` is the record filter (a separate axis), not a who-can-see control; a list view with NO `<sharedTo>` is visible to all users who can see the object (\"visible only to me\" personal views are not in deployed metadata, so absence is never \"private\"). Unknown ListView → `component-not-found`; a non-`CustomObject:`/`ListView:` prefix → `invalid-query`.",
    inputSchema: LIST_VIEW_SHARING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.app_access',
    description:
      "Given a `CustomApplication` (`componentId`, e.g. `CustomApplication:Sales`), return what's IN the app and WHO can use it: `navType` (Standard/Console/Classic), `tabs` (the app's `CustomTab:` ids in document order, from `belongsToApp` edges), `canOpen` (the Profiles/PermissionSets whose `applicationVisibilities` mark the app `visible: true`, paginated via `limit`/`offset`), and `defaultedBy` (the granters for which this is the DEFAULT app — complete). `summary` tallies tabs / canOpen / defaultedBy. `declared` confidence. `boundaryNote`: who-can-open is the applicationVisibilities grant — actual access also needs the user to be ASSIGNED the profile/permission set (runtime, not modeled); if no granter carries an extracted `applicationVisibilities` the list is disclosed as 'not modeled', not a verified empty. `scanTruncated: true` (with a `boundaryNote`) when the Profile/PermissionSet scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`) — the granter list may be incomplete. App visibility (`applicationVisibilities`) is extracted at every refresh; only a vault refreshed before the P11 extraction answers 'not modeled' (re-run `/sfi-refresh`). Unknown app → `component-not-found`; non-`CustomApplication:` prefix → `invalid-query`. INVERSE direction (P14-APP-default-reverse): pass a `Profile:` or `PermissionSet:` id instead and the response answers FROM the granter's own applicationVisibilities — `openableApps[]` (visible: true) and `defaultApp` (or null), one node read; a granter without the extracted property answers \"not modeled\", never a verified empty. `PermissionSetGroup:` ids are refused with the honest union explanation (PSG visibility = union of member permission sets, not directly extracted).",
    inputSchema: APP_ACCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tab_availability',
    description:
      "Given a `Profile:X` or `PermissionSet:X` (`componentId`), list the tabs it can see: each row carries the `tab`, the verbatim `visibility` enum (`DefaultOn`/`DefaultOff`/`Hidden` on a profile; `Available`/`Visible`/`None` on a permission set), and an `available` flag normalising 'the user can reach this tab'. `summary` tallies total / available / hidden; the list pages (`limit` default 200 / max 500, `offset`/`hasMore`/`truncated`). `declared` confidence. `boundaryNote`: a tab being available does NOT grant object access (use `object_access_audit`), and the user must be ASSIGNED this profile/permission set (runtime, not modeled); an un-extracted `tabVisibilities` is disclosed as 'not modeled'. Tab visibility is extracted at every refresh (Profile `<tabVisibilities>` and PermissionSet `<tabSettings>` both land on `properties.tabVisibilities`); only a vault refreshed before the P11 extraction answers 'not modeled' (re-run `/sfi-refresh`). Unknown id → `component-not-found`; non-Profile/PermissionSet prefix → `invalid-query`.",
    inputSchema: TAB_AVAILABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lifecycle_process',
    description:
      "\"What happens when {Object}.{field} becomes {value}?\" — a value / stage LIFECYCLE view, not a bare DML-event view. `order_of_execution` / `what_happens_on_save` answer \"what runs on an insert/update\"; this stitches the parts into the JOURNEY of a specific transition (Opportunity → Closed Won, a Case status flip, a record updated into a state). It COMPOSES `order_of_execution` for the transition's event (default `update`; pass `event: 'insert'` for creation) — so the chain always agrees with that tool — and ANNOTATES each step with `coupledToField` (its entry condition references the transition `field`) and `coupledToValue` (the condition expression mentions the `value` literal). `process[]` is the ordered, paginated automation chain (`limit` default 100 / max 200, `offset`/`hasMore`/`truncated`); `coupledAutomation[]` is the COMPLETE subset gated on the transition (the value-add); `summary` tallies total / coupled / field-coupled / value-coupled. `confidence: 'parsed'`. `disclosures` is explicit: conditions are LISTED not EVALUATED (whether a record matches needs record data), value coupling is a literal expression match (can miss formula-encoded values / over-match a substring), and the chain excludes manual actions, the runtime audit trail, roll-up/cross-object recalculation, and callouts. With no `field`/`value` it returns the full chain plus a hint to pass a transition. Unknown object surfaces via the underlying order_of_execution error.",
    inputSchema: LIFECYCLE_PROCESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.layout_assignments',
    description:
      "The REVERSE of `sfi.layout_for_user`: given a page Layout canonical id (`componentId`, e.g. `Layout:Account.Account Layout`), enumerate every (Profile × RecordType) assignment that targets it — the question an admin asks before editing or deleting a layout. Reads the same `properties.layoutAssignments` surface the forward tool routes through (so the two agree by construction). Each assignment carries the `profileId`, `profileLabel`, the `recordType` axis (the bare `{Object}.{RT}` form, or `null` for the object's default/master assignment), and the canonical `recordTypeId`. `summary` reports distinct profiles + total assignments (COMPLETE, not paginated). A widely-shared standard-object layout (e.g. Account) is assigned by every profile × record type — hundreds of rows past the MCP response limit — so the inline `assignments` list PAGES via `limit` (default 120, max 250) / `offset` / `hasMore` / `truncated`. `declared` confidence. Honesty axis: CLASSIC page-layout assignments via Profiles only — Lightning record pages (FlexiPage) and the org-wide default layout assign differently and are not covered (`boundaryNote`); if no profile in the vault carries an extracted `layoutAssignments` property, `boundaryNote` discloses the result is \"not modeled\", not a verified \"no assignments\". `scanTruncated: true` (with a `boundaryNote`) when the Profile scan hits the per-type node cap (500, `SFI_NODE_SCAN_LIMIT`) — assignments may be incomplete on a very large org. Unknown layout id → `component-not-found`; a non-`Layout:` prefix → `invalid-query`.",
    inputSchema: LAYOUT_ASSIGNMENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.integration_map',
    description:
      "Return a structured topology of the org's integration surfaces: AuthProviders, NamedCredentials, RemoteSiteSettings, CspTrustedSites, ExternalDataSources, ExternalServices, ConnectedApps, NetworkAccess entries, plus the cross-type `references` edges connecting them (e.g., ExternalDataSource → AuthProvider). Optional `filter` narrows the result to one architectural cut (auth / sites / sources / services / access); default `all` returns every category.",
    inputSchema: INTEGRATION_MAP_INPUT_SCHEMA,
  },
  {
    name: 'sfi.event_subscribers',
    description:
      "Given a Platform Event id (`CustomObject:{ApiName}__e`), list every subscriber (ApexTrigger, ApexClass, Flow) that emits an incoming `listensTo` edge into the event. OMIT `eventId` for CATALOG mode: every Platform Event in the org with its subscriber count (`events[]`) — answers \"what platform events does this org publish?\" (then `subscribers` is `[]` and `eventApiName` is `null`). Single-event mode returns each subscriber's identity, the emitting extractor, and edge-level subscription metadata. Honest empty list when no subscribers exist; `invalid-query` when a supplied id is not a Platform Event canonical form. `boundaries[]` carries the heuristic-detection disclosure; an empty subscriber list adds an empty≠absent line (CDC/dynamic/managed subscriptions not modeled), never a silent empty.",
    inputSchema: EVENT_SUBSCRIBERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.guidance',
    description:
      "General Salesforce best-practice guidance — the `knowledge` plane for greenfield / New-Org questions that have NO org-specific answer (Flow vs Apex, order of execution, governor limits, async Apex, trigger frameworks, bulkification, Apex testing, callouts, SFDX, unlocked packages, profiles vs permission sets, OWD/sharing, standard vs custom objects, naming, sandboxes). With `topic` (a key like `flow-vs-apex`, or a phrase that loose-matches) it returns a curated summary plus links to official Salesforce docs; without `topic` it lists available topics. Explicitly NOT specific to this org (see `disclosure`) — it points to authoritative docs and never fabricates vault data.",
    inputSchema: GUIDANCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_code_usages',
    description:
      "List the code source files (ApexClass, ApexTrigger, LightningComponentBundle, AuraDefinitionBundle, VisualforcePage, VisualforceComponent) that read, write, call, or reference a component. Strict superset of `sfi.find_apex_usages`: same Apex-source coverage plus the v1.4 frontend tier. Filters incoming `readsFrom`/`writesTo`/`callsApex`/`references` edges to those originating from one of the six code node types; optional `nodeTypes` narrows to a single producer (e.g., `['LightningComponentBundle']` for LWC-only). LWC apex-import callsApex edges are `declared`; LWC field reads, Aura field accesses, and VF field touches are `heuristic`; VF controller/extension references are `declared`. `boundaries[]` always carries the heuristic-scanner disclosure; an EMPTY result adds an explicit empty≠absent line (no code usages found is NOT proof nothing uses it — cross-check `find_component_usages`), never a silent empty. A truncated page returns a `nextCursor` to resume.",
    inputSchema: FIND_CODE_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.lookup_record',
    description:
      "Given a CustomMetadataRecord or CustomSettingRecord canonical id (e.g., `CustomMetadataRecord:Marketo_Api_Setting__mdt.Default`), return the record's label, protected flag, parent type ApiName, and the full per-field value list. Each value carries `field`, `value`, `valueType`, and `isMasked`; managed-package masked content surfaces as `{ value: null, isMasked: true }` (the v1.6 R2 extractor honesty axis — values masked by Salesforce as the literal `***` are NOT fabricated). `invalid-query` when the id does not start with one of the two record-type prefixes; `component-not-found` when the record id is unknown to the vault.",
    inputSchema: LOOKUP_RECORD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_field',
    description:
      "Given a CustomField canonical id (e.g., `CustomField:Account.Industry` or `CustomField:Marketo_Api_Setting__mdt.Number_Of_Retries__c`), return the field's label, description, type, required flag, and — for Picklist / MultiselectPicklist fields — `picklistValues`: the DECLARED value set from the field's inline value-set definition (the literal answer to \"what values are in this picklist?\"). Each entry is an object `{ value, isActive, label?, default? }`: `isActive: false` marks a DEACTIVATED value — RETAINED but not selectable for new records, though existing records may still hold it — so inactive values are LISTED-and-marked, never dropped and never presented as current (H10). (Vaults refreshed before this change stored bare value strings; those normalize to `isActive: true`.) `picklistValues` is `null` for non-picklist fields; for picklists whose value set is a GlobalValueSet reference, the tool FOLLOWS the field's `usesValueSet` edge (vaults refreshed at 0.1.10+) and returns the value set's declared values with `picklistValuesSource` citing the GlobalValueSet id — GVS-resolved values report `isActive: true` UNVERIFIED (the value-set extractor does not yet carry per-value active status), disclosed via `picklistValuesNote`. Only when the link cannot resolve (older vault, value set not retrieved) does the response fall back to `null` plus `picklistValuesNote`, so `null` never reads as \"no values\"; an EMPTY array is a real zero-value inline definition. When the parent type ends in `__mdt` (CustomMetadataDefinition), the response additionally carries `recordValues`: one entry per CustomMetadataRecord child of the parent that holds a value for this field (records lacking a value are omitted — the v1.6 honesty axis). Set `includeRecordValues: false` to suppress the cross-record enumeration even for `__mdt` parents; set `true` to force it for non-`__mdt` parents (yields an empty array since those parents have no CustomMetadataRecord children).",
    inputSchema: EXPLAIN_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.safe_to_delete_field',
    description:
      "Given a CustomField canonical id (`CustomField:{Object}.{Field}`), composes every incoming dependency edge into a confidence-weighted deletion verdict: `safe` (no incoming edges), `risky` (heuristic-confidence Apex/LWC references that need spot-checking), `blocking` (declared Flow/ValidationRule/Layout/formula dependencies the platform will refuse to drop), `unknown` (only unrecognised edges), or `review` (NOT proven safe — incomplete coverage, OR a standard / managed-package field with no node of its own but referenced by edges: it is reviewed from those edges with a not-modeled caveat instead of returning component-not-found; B12). Each category in the `reasoning` array carries its referrer count, up to 5 example referrers (full list via `sfi.get_impact`), and a per-category note explaining the honesty boundary. Does NOT consult the Tooling API for runtime dependency confirmation (deferred to v1.7+ `dependsOnFromApi` enrichment). Pass `format: 'checklist'` to also get a `checklist` — a \"before you delete X\" Markdown checklist rendered from the verdict + reasoning, with the `coverageCaveat` surfaced FIRST (never footnoted) and removal steps ordered most-severe-first. It PROPOSES a checklist for a human and never deletes or writes to the org. When the vault holds captured data-shape facts, the response embeds the field's sampled fill rate as a stamped `data_snapshot` `dataShape` block — CONTEXT ONLY: the verdict is computed purely from the metadata graph and never moves toward safe on a sampled observation.",
    inputSchema: SAFE_TO_DELETE_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unused_components',
    description:
      "Scan the vault for components with no incoming USAGE edges (excluding the parentOf containment edge and grantedBy access grants — a Profile / PermissionSet granting access is not usage, so a component nobody references is still unused). Default `types` is a curated subset (CustomField, ApexClass, ApexTrigger, Flow, PermissionSet, Queue, Group, Role, EmailTemplate, Letterhead, GlobalValueSet, CustomLabel, StaticResource, ValidationRule, WorkflowRule); supply `types` to narrow. Test ApexClasses (properties.isTest === true) are NEVER flagged as unused. Each entry carries a per-type `invisibleReferencesNote` enumerating what the v1.x extractors cannot see (dynamic SOQL, reflective Apex, permission-set assignments, runtime callouts). `byType` carries the full per-type counts (not the truncated slice); `truncated` is true when the global slice was trimmed to `limit`, and a truncated page returns a `nextCursor` to resume. When any REFERRER family (Reports, Flows, layouts, LWC, …) has incomplete coverage — errored retrieve, scoped refresh, or an in-progress staged build — the response carries a `coverageCaveat` naming the families: \"unused\" then means \"no RETRIEVED metadata references it\", never proven absence.",
    inputSchema: UNUSED_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_dependency_cycles',
    description:
      "Architect tool: find cyclic dependency clusters in the org's Apex. Runs Tarjan's strongly-connected-components over `callsApex` edges among ApexClass + ApexTrigger nodes and returns every cyclic cluster (SCC of size > 1) plus self-recursive classes (size-1 SCCs with a self-edge), ordered by size descending. Each `cycles[]` entry carries the member component ids, the cluster `size`, and `selfRecursive`. `summary` reports apexNodesScanned, callsApexEdgesConsidered, cyclicClusters, largestClusterSize, and truncated. Honesty axis: `callsApex` is heuristic static analysis — dynamic dispatch (Type.forName, interface polymorphism) is invisible, so the reported set is a LOWER BOUND; a cluster means the listed components statically reference one another in a loop (investigate fragility / deploy-order / test-isolation), not proven runtime recursion. `limit` (default 50, max 200) caps the returned clusters; a truncated page returns a `nextCursor` to resume.",
    inputSchema: FIND_DEPENDENCY_CYCLES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.apex_test_coverage',
    description:
      "Developer tool: map test-class references to the Apex they exercise. With `classApiName`, returns the test classes that statically reference it (`target.coveringTests`) and a `status` of has-test-references / no-test-references-found. Without it, returns the org-wide `untestedClasses` backlog — non-test ApexClasses with NO incoming `callsApex` from any test class (the gap behind the Salesforce 75%-coverage deploy gate). `summary` reports testClasses, nonTestClasses, classesWithTestReferences, classesWithoutTestReferences, truncated. Honesty axis: this is STATIC reference coverage, NOT runtime line-coverage % — a referencing test may not exercise every line and dynamic invocation is invisible, so 'untested' means 'no static test reference found', not proven zero coverage; the authoritative number comes from running the org's Apex tests. `limit` (default 100, max 500) caps the org-wide list; a truncated page returns a `nextCursor` to resume.",
    inputSchema: APEX_TEST_COVERAGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.automation_build_advisor',
    description:
      "Decision-support tool: before an admin/architect builds automation on an object, brief them on what already runs there and the org-specific risks of adding more. Given `objectApiName`, returns `existingAutomation` (record-triggered Flows with recordTriggerType+status, ApexTriggers, ValidationRules, WorkflowRules that target the object), `risks` (flow-ordering when ≥2 active record-triggered Flows share the object since Salesforce does not guarantee their order; mixed-trigger-and-flow when both paradigms are present; validation-load when ≥5 active rules; greenfield when none), and synthesised `recommendations`. Does NOT build anything — it arms the decision (this is a backend knowledge layer). Honesty axis: lists automation that TARGETS the object (every entry a real vault node, not a fabricated save sequence), conditions are not evaluated, and runtime Flow Trigger Order / dynamic invocation are out of scope. Pair with sfi.what_happens_on_save for the full ordered sequence.",
    inputSchema: AUTOMATION_BUILD_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.apex_build_advisor',
    description:
      "Decision-support tool: before a developer writes Apex, brief them on what the org's existing Apex teaches. Synthesises `governorPitfalls` (the soql-in-loop / dml-in-loop risks ALREADY in the org — the patterns to avoid), `testExpectations` (the 75% production-deploy coverage gate + the org's untested-class backlog), `flsCrudNorms` (whether existing Apex enforces CRUD/FLS and how often it skips it), and — when `objectApiName` is given — `similarLogic` (the Apex that already touches that object, so you reuse instead of duplicate), plus synthesised `recommendations`. Composes governor_limit_risks + apex_test_coverage + crud_fls_audit; each section degrades to null with a note if its scan can't run. Does NOT write code (backend knowledge layer). Honesty axis: heuristic static analysis over the last refresh — 'what the org's Apex shows', not a guarantee about new code.",
    inputSchema: APEX_BUILD_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_change_advisor',
    description:
      "Decision-support tool: before changing a field, see the whole blast radius in one briefing. Given `fieldId`, synthesises `makeRequired` (verdict + create-path impact count from what_if_make_field_required), `deletion` (verdict + blocking/risky dependency counts from safe_to_delete_field), and — when `newType` is given — `changeType` (compatibility + verdict + reference count from what_if_change_field_type), plus combined `recommendations`. Does NOT change anything (backend knowledge layer). Honesty axis: inherits the composed tools' boundaries — dataflow into Apex insert/update and dynamic/reflective field access are invisible, so verdicts mean 'investigate', not guarantees. `component-not-found` when the fieldId is not a CustomField in the vault. HYBRID (P6-live-advisor-wire): pass `liveEnabled: true` (or grant consent) and `makeRequired` additionally carries the field's LIVE production null-rate (`liveNullRate`), and the `recommendations` cite the live record population alongside the vault impact (with a staleness lead when the org is ahead of the vault).",
    inputSchema: FIELD_CHANGE_ADVISOR_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_field_value',
    description:
      "Value-change impact (Data Steward / Identity & Integration lens): given a CustomField `fieldId`, what breaks if its stored VALUE changes — NOT its schema (use what_if_change_field_type for type/required/delete). Returns impact buckets (identity / integration-key / uniqueness / automation / save-pipeline / display), an overall severity, honesty-surface disclosures, and recommended pre-change checks. Identity / key / uniqueness verdicts come from the field's own metadata (externalId / unique / idLookup, identity catalog) — so a value change is flagged even on a field with ZERO references (e.g. a SAML federation key). Derived fields (formula / roll-up / auto-number) return mutable:false and re-route to their source. Honesty axis: the vault cannot see external upsert systems, the IdP side of SSO, or dynamic / managed-package code; automation buckets surface declarative value-literal couplings (the value a rule compares this field to); Apex literal comparisons remain invisible. Optional `newValue` adds a targeted collision/acceptance check. `component-not-found` when the fieldId is not a CustomField in the vault.",
    inputSchema: WHAT_IF_CHANGE_FIELD_VALUE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.value_change_audit',
    description:
      "Batch value-change audit (Data Steward lens): given an `object` and optionally a list of `fields`, risk-ranks the impact of changing each field's stored VALUE — the portfolio version of what_if_change_field_value. WITHOUT `fields`, auto-detects the value-sensitive fields on the object (upsert keys via externalId/unique/idLookup, identity-catalog fields, name-lexicon matches). Each row carries an overall severity, role, top impact reasons, confidence, and disclosure count; `verbosity:'detail'` inlines full buckets. Returns a severity summary + global disclosures; unknown explicit fields come back in `notFound`. This answers 'tell me if changing any of these has an impact on {object}'. Honesty axis: auto-detect can miss a value-sensitive field carrying none of those signals; per-row blast radius inherits what_if_change_field_value's boundaries (external upsert systems, IdP side of SSO, dynamic/managed-package code invisible).",
    inputSchema: VALUE_CHANGE_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.live_drift_check',
    description:
      "Offline↔live contradiction detection (requires the opt-in live plane). For `objectApiName`, compares the fields the vault recorded at the last refresh against a LIVE read-only describe and reports `onlyInVault` (fields in the snapshot the live org no longer returns — deleted/renamed/permission-hidden since refresh; the high-signal STALE indicator), `onlyInLiveCustom` (custom fields added live since refresh, filtered to `__`-suffixed to avoid standard-field noise), `inSync`, and a plain-language `interpretation`. The only check that uses BOTH planes at once; never mutates the org. Honesty axis: the vault models extracted custom fields + standard object definitions (not standard fields), so onlyInVault is the trustworthy drift signal. Pass `liveEnabled:true` or set SFI_LIVE_PLANE_ENABLED.",
    inputSchema: LIVE_DRIFT_CHECK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_changed_since_refresh',
    description:
      "P5-what-changed: 'since my last refresh, which component TYPES changed?'. Reads the continuous-learning store's MOST RECENT refresh entry and returns the non-zero per-type `changedTypes` (signed: + added / − removed), `changedTypeCount`, `changedEdges`, `lastRefreshedAt`, and a plain-language `interpretation`. Takes no arguments. Read-only. Honesty axis (load-bearing): these are the changes the LAST REFRESH brought INTO the vault vs the prior snapshot — NOT what changed in the live org SINCE (an offline vault cannot know that). For the real org-side drift count, run `sfi.live_stale_check`. `available:false` for a vault with no recorded history.",
    inputSchema: WHAT_CHANGED_SINCE_REFRESH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_history',
    description:
      "Continuous-learning store: the org's refresh timeline. Every `sfi refresh` appends its per-type component/edge deltas to meta/history.jsonl; this returns that timeline (most recent first) plus `refreshCount`, `firstRefreshedAt`, `lastRefreshedAt`, and `netComponentChange` (total components last − first). Lets answers reason over 'what was true before + what changed' instead of only the latest snapshot. Read-only. Honesty axis: only covers refreshes since the store shipped (single-refresh/older vaults yield a short or empty timeline); each entry's deltas are as-recorded vs the prior refresh, not recomputed. `limit` (default 50, max 500).",
    inputSchema: ORG_HISTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.diff_snapshots',
    description:
      "Compare two captured vault snapshots and report the structural diff. `fromLabel` and `toLabel` name persisted snapshots under `{vaultRoot}/snapshots/`; the special value `'current'` for `toLabel` triggers a transient capture of the live graph (no persisted artefact). Returns `added` (ids in `to` but not `from`), `removed` (ids in `from` but not `to`), and `modified` (ids present in both whose canonicalized properties or structural identity changed). Each entry carries the component's `id`, `type`, and `apiName`. `summary` reports the full per-bucket counts; the emitted arrays are trimmed to `limit` (default 100, max 500) and `truncated` flips true when the total exceeds `limit`. When a diff is large, ONE list (the largest) is paged via `nextCursor`; the other two are disclosed by full count in `summary` + `otherSections` (echo `nextCursor` back as `cursor` to advance). Edges are NOT surfaced in the v2.0c output — re-query a specific component pair via `sfi.compare_components` for edge-level detail. `invalid-query` when either label is unknown.",
    inputSchema: DIFF_SNAPSHOTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.churn',
    description:
      'Compare two persisted snapshots and return added/removed/modified counts plus top churn ids.',
    inputSchema: CHURN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.trend',
    description:
      'Timeline of persisted snapshot captures (component/edge counts per label).',
    inputSchema: TREND_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_components',
    description:
      "Compare two live-graph components by canonical id, returning the structural diff. `fieldDiffs` enumerates the union of top-level identity fields (type, apiName, label, parentId) and one-level-deep flattened properties; each entry carries `valueA`/`valueB`/`status` where status is `same` / `different` / `a-only` / `b-only`. `edgeDiffs` enumerates the symmetric difference of outgoing and incoming edges matched on `(direction, target, edgeType)`; each entry carries `inA` / `inB` flags. Cross-type comparisons (e.g., Profile vs PermissionSet, ApexClass vs Flow) are allowed; `typesMatch: false` signals the consumer should expect a property diff dominated by `a-only` / `b-only` entries. Unknown ids surface as `component-not-found`. Operates on the current live graph, never on snapshots. Pass `format: 'ps-diff'` to also get a `psDiff` — a deploy-tool-friendly Permission-Set / Profile grant diff (added/removed object/field/class grants from grantedBy edge presence + userPermissions set-difference, bucketed by category with a summary), validated against `docs/schemas/ps-diff.schema.json`. It PROPOSES a diff to feed Gearset/Copado and never writes to the org; an existing grant's read↔edit LEVEL change is not surfaced (the vault models those grants as edges and skips all-false grants — see the psDiff `disclosure`).",
    inputSchema: COMPARE_COMPONENTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.export_manifest',
    description:
      "Group a set of canonical component ids into a well-formed `package.xml` snippet (P8-manifest-export) a human can hand to Gearset / Copado / `sf project deploy`. Takes `componentIds` (non-empty array of `Type:Member` ids) and an optional `apiVersion` (default 62.0); returns `packageXml` (the manifest text — members de-duplicated and sorted per type, the `<name>` mapped to the deployable metadata-type name so e.g. `WorkflowRule`→`Workflow`, `VisualforcePage`→`ApexPage`), a `summary` (typeCount / memberCount / per-type rollup), and `skipped` (ids that are malformed or synthetic graph nodes like `ConditionalContext`, with the reason). It PROPOSES a manifest and NEVER deploys or writes to the org; it does not verify the ids exist (it packages exactly what you pass — see the `disclosure`).",
    inputSchema: EXPORT_MANIFEST_INPUT_SCHEMA,
  },
  {
    name: 'sfi.pii_inventory',
    description:
      "Enumerate every CustomField in the vault, classify each with the v2.0d `pii-detection` recognizer (which inspects API name, declared data type, and description text), then emit a structured inventory. Filter by `classification` (`'pii' | 'sensitive' | 'all'`) and/or `category` (`'identifier' | 'contact' | 'financial' | 'health' | 'all'`); both default to `'all'`. Each emitted field carries its classification, category, data type, description, and a plain-English `reason` naming the rule that fired. `summary` reports the full per-classification and per-category counts across the matched set. The response is paginated: `limit` (default 200, max 500) and `offset` (default 0) page through the inventory, and a per-response ~38 KB byte budget trims the `fields` slice further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more matching fields remain, with `nextOffset` carrying the cursor to advance (plus a `note` when a page was byte-trimmed). The recognizer is heuristic — a field with no name-token match and no description signal classifies as `public` even if it stores PII at runtime; `EncryptedText`-typed fields ALWAYS classify as `sensitive` because the encryption type IS the declaration.",
    inputSchema: PII_INVENTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_access_audit',
    description:
      "Given a CustomField canonical id (`CustomField:{Object}.{Field}`), cross-walk every Profile and PermissionSet that grants access to the field via incoming `grantedBy` edges. `grants` carries one entry per (Profile or PermissionSet, permission level) pair where permission is `'read'` / `'edit'` / `'unknown'` (the last meaning the older extractor did not populate the per-flag axis). `summary` reports the unfiltered counts split four ways (profilesWithRead, profilesWithEdit, permSetsWithRead, permSetsWithEdit). `viaApexAccess` enumerates ApexClass / ApexTrigger nodes with incoming `readsFrom` / `writesTo` edges to the field — a user with execute permission on one of those classes may access the field through that code path even when the metadata-grant audit reports no direct grant. Optional `permissionType` (`'read' | 'edit' | 'all'`, default `'all'`) narrows the emitted `grants` array. A standard or managed-package field with no node of its own but referenced by fieldPermissions / Apex edges is still audited from those edges with `notModeled: true` + a `notModeledNote` (grants are accurate; data type / formula are unavailable and PII is inferred from the field name) — only an id with no node AND no inbound references is `component-not-found` (B12). Honesty axis: this is the v2.0d.0 permission-grant-level audit; criteria-based and account-team sharing rules are deferred to v2.0d.1. Invalid prefix surfaces as `invalid-query`. The `update` block answers \"who can UPDATE this field\": `fieldUpdatable` is false for formula / auto-number / roll-up-summary fields (value is derived); `canUpdate` lists the grantors with FLS-edit on the field AND edit on the PARENT OBJECT (the intersection — FLS-edit alone is not enough; object-edit counts explicit object Edit / object Modify All grants AND the `ModifyAllData` system permission, which implies object-edit on every object but does NOT bypass FLS); `recordEditDependency` reminds that edit access to the specific RECORD is also required (use `why_cant_user_see_record` with `accessLevel: 'edit'`).",
    inputSchema: FIELD_ACCESS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.object_access_audit',
    description:
      "Given a CustomObject canonical id (`CustomObject:{ApiName}`), enumerate every Profile and PermissionSet that grants OBJECT-level access via incoming `grantedBy` edges. Each `grants` entry carries the granter + its CRUD bits (`allowCreate` / `allowRead` / `allowEdit` / `allowDelete`) and the object-level `viewAllRecords` (\"View All\") / `modifyAllRecords` (\"Modify All\") flags. PermissionSetGroup-conferred access is ALSO surfaced (CR-CAP-04): a PSG has no `grantedBy` edge of its own, so for each granting permission set the tool REVERSE-looks-up the groups that contain it and emits an additional `granterType: 'PermissionSetGroup'` row copying the member's CRUD flags — included as a DISTINCT access path (intentionally NOT deduped against the direct row; both are honest paths, and the PSG counts toward `summary.distinctGranters`). Muting permission sets are DISCLOSED in `note`, never subtracted. `summary` tallies how many granters hold each bit. This is the object-level counterpart to `field_access_audit` (field FLS) — and it is OBJECT permissions, NOT record-level visibility: for \"can a user see/edit a specific RECORD\" (OWD + sharing + role hierarchy) use `why_cant_user_see_record`; the two compose (a user needs the object grant here AND record access there). A standard / managed-package object with no node of its own but referenced by permission edges is still audited with `notModeled: true` + a note; an id with no node AND no inbound grants is `component-not-found`. Confidence: `declared` (object permissions are declared metadata). A non-`CustomObject:` prefix is `invalid-query`.",
    inputSchema: OBJECT_ACCESS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.recordtype_availability',
    description:
      "Given a Profile or PermissionSet canonical id (`Profile:{Name}` / `PermissionSet:{Name}`), report which record types the user can CREATE / see, grouped by object, from the granter's `recordTypeVisibilities`. Each record type carries `visible` (a visible record type is one the user can pick when creating a record — i.e. it gates \"who can create a record\" together with the object's Create permission from `object_access_audit`) and `default` (the user's default for that object); each object surfaces its `defaultRecordType`. `summary` tallies objects + visible record types. Confidence: `declared` (record-type visibility is declared profile metadata). `boundaryNote`: when the granter carries no extracted `recordTypeVisibilities` property (a pre-extraction / stale vault), the empty result is disclosed as \"not modeled\" (re-run `/sfi-refresh`), NOT a verified \"no record types\" — like `tab_availability`. A non-Profile/PermissionSet id is `invalid-query`; an unknown id is `component-not-found`.",
    inputSchema: RECORDTYPE_AVAILABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.org_overview',
    description:
      "Return a structured org-tour snapshot — the buyer-priority #9 headline answer for the new-to-this-org persona. Composes existing graph queries into ten coordinated views: per-ComponentType counts; top 10 CustomObjects ranked by inbound non-parentOf edge count (proxy for the central data model); top 10 ApexClasses ranked by inbound `callsApex` edges (proxy for the hot-path code); top 10 Profiles ranked by outgoing `grantedBy` edges (v1.x proxy for broadest profiles since user-assignment data isn't extracted); integration-surface summary (NamedCredential, AuthProvider, RemoteSiteSetting, ExternalDataSource, ExternalService, ConnectedApp + total); automation summary (WorkflowRule, ApprovalProcess, Flow, ApexTrigger + active ratio); frontend summary (LWC, Aura, VF page, VF component + legacy VF debt ratio); legacy-debt indicators bucketed into `low | medium | high` migration-candidate; top 5 ApexClasses by source bytes/line count; and the naming-convention recognizer output. Takes no arguments. Honesty axis: every \"top X\" is a heuristic proxy — should be cited as \"suggested starting point\", not \"authoritative ranking\". When the vault holds captured data-shape facts (`refresh --with-data-shape`), the response embeds `dataShape.recordCounts` — stamped approximate counts for the top objects (`data_snapshot`; storage-level, never a live read).",
    inputSchema: ORG_OVERVIEW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.domain_clusters',
    description:
      "Cluster the org's CustomObject + ApexClass + Flow nodes into SUGGESTED domain groupings using a greedy shared-edge-density algorithm. Pairs candidate components, computes density as `|shared neighbors| / max(degree(A), degree(B))`, and groups candidates whose density meets the `minDensity` threshold (default 0.3, range [0.0, 1.0]). Each cluster is named after its highest-degree CustomObject (\"{ApiName}-centered domain (suggested grouping)\") so the heuristic provenance is visible in the label itself. Returns up to `limit` clusters (default 10, max 50), sorted by member count DESC, plus an `unclustered` count of candidates that didn't meet the density bar with anyone. Each cluster lists up to 40 `members` with the true `memberCount` + `membersTruncated` (so one large domain can't blow the response), and a per-response ~36 KB byte budget trims the cluster count further if needed (with a `note`) so the result never trips the global ~45 KB MCP response limit. When a cluster has more than 40 members, that cluster is paged via `nextCursor` (echo it back as `cursor` to walk its members); `candidateTruncated` flags a >500-per-type candidate scan. Honesty axis (load-bearing): clusters are HEURISTIC — they reflect topology, not semantics. A real org's domain boundaries are decided by humans; this tool surfaces \"these components share many edges\" as a starting point for further investigation, never as a confirmed domain assignment.",
    inputSchema: DOMAIN_CLUSTERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.changed_since',
    description:
      "Enumerate every vault node whose `lastModifiedDate` is at or after `since` (ISO 8601 — date-only `YYYY-MM-DD` or full UTC timestamp). Optional `types` narrows the scan; default scans every ComponentType. Optional `limit` (1-500, default 100) truncates the response; a truncated page returns a `nextCursor` to resume. Each entry carries `id`, `type`, `apiName`, `lastModifiedDate`, and `lastModifiedBy: { id, name }`. The output's `unenrichedCount` reports how many nodes (within the requested types) carry `lastModifiedDate: null` — these are the nodes the offline DX-source extractor produced without freshness data. Honesty axis (load-bearing): a non-zero `unenrichedCount` means the answer is PARTIAL. Run `sfi refresh --with-tooling-api` to enrich the freshness fields via the v1.7 Tooling API integration; the tool remains fully functional against an un-enriched vault (returns `changed: []` plus the full `unenrichedCount` so consumers see the gap rather than assuming nothing has changed). The v1.7 R2 Tooling API enricher covers ApexClass, ApexTrigger, Flow, Layout, CustomField, and ValidationRule; future v1.7+ R3 expands coverage to the remaining types.",
    inputSchema: CHANGED_SINCE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.last_modified',
    description:
      "Given a canonical componentId (e.g., `ApexClass:AccountController`, `CustomField:Account.Industry`, `Flow:Lead_Nurture`), return the component's freshness fields: `lastModifiedDate` (ISO 8601 or null), `lastModifiedBy: { id, name }` (or null), and `apiVersion` (number or null). The output carries an explicit `enriched: boolean` honesty flag — `true` when at least one freshness axis is populated (either from the v1.7 `properties.lastModifiedDate` / `properties.lastModifiedBy` overlay written by the Tooling API enricher, OR from the legacy top-level `lastModifiedDate` field that some DX-source extractors emit pre-enrichment); `false` when every axis is null. When `enriched: false`, the `disclosure` field carries the verbatim recommendation: \"v1.7 Tooling API enrichment has not run for this vault. Run `sfi refresh --with-tooling-api --target-org <alias>` to populate lastModifiedDate / lastModifiedBy / apiVersion for the enriched types.\" Honesty axis: the v1.7 Tooling API enricher covers ApexClass, ApexTrigger, Flow, Layout, CustomField, and ValidationRule; other ComponentTypes return `enriched: false` until a future enrichment pass extends coverage. `lastModifiedBy` is the user who last DEPLOYED the change — not necessarily the original author. `component-not-found` when the id is unknown to the vault.",
    inputSchema: LAST_MODIFIED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_happens_on_save',
    description:
      "Produce the documented Salesforce order-of-execution (SOE) instantiated for THIS org and the given DML event on the target object. Walks the canonical SOE phases in order — before-save-flows (before-save record-triggered Flows — `triggersOn` edge `triggerType` RecordBeforeSave — which run FIRST, ahead of before-triggers; insert/update only), pre-save-validation (ValidationRules), pre-save-triggers + after-triggers (ApexTriggers whose `events` includes a matching `before <event>` / `after <event>` lifecycle entry), save (a documented placeholder for system validation + DB write), post-save-flows (record-triggered AFTER-save Flows whose `recordTriggerType` matches the event), post-save-workflows (WorkflowRules whose `triggerType` matches), post-save-assignment (Lead/Case AssignmentRules + AutoResponseRules + EscalationRules parented to the object), post-save-approval (ApprovalProcesses parented to the object), and post-save-async (ApexClasses dispatched via `dispatchesAsync` from any trigger above). Only ACTIVE automation is listed as execution steps — Draft/Obsolete Flows and active:false rules/processes are omitted from `soe` and surfaced in `inactiveConfigured` when present. Each step carries the firer's id/type/apiName, the gating `firesWhen` ConditionalContext when one exists, and an actions array enumerating the firer's outgoing edges (excluding structural parentOf/triggersOn/firesWhen). Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them. Workflow field updates can re-fire before/after-update triggers (a second pass); the composition lists each automation once. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    inputSchema: WHAT_HAPPENS_ON_SAVE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.why_field_changed',
    description:
      "Trace every writer to a CustomField. Walks every incoming `writesTo` edge to `fieldId` and surfaces each writer with its identity (`id`/`type`/`apiName`), its edge-level confidence (`declared` for metadata-declared writes — Flow recordCreates/Updates, WorkflowRule field-update actions; `parsed` for formula-tokenizer references; `heuristic` for Apex-scanner-emitted writes that may include false positives), the gating `firesWhen` ConditionalContext when one exists, and (for ApexTrigger writers) the trigger's lifecycle events. Returns a categorisation summary (`declaredCount` / `heuristicCount`) so callers can show the confidence boundary. Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them; heuristic-confidence Apex writes need spot-checking before refactoring. Invalid `fieldId` prefix surfaces as `invalid-query`; unknown but well-formed ids surface as `component-not-found`.",
    inputSchema: WHY_FIELD_CHANGED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.order_of_execution',
    description:
      "Emit the generic Salesforce order-of-execution (SOE) tree instantiated for THIS org's target object across every supported DML event (insert / update / delete / undelete; upsert is a client-side composition of insert + update). Sibling of `sfi.what_happens_on_save` without the event filter — returns the same per-phase step shape (including the leading `before-save-flows` phase for before-save record-triggered Flows), but as a per-event map (`byEvent.{insert|update|delete|undelete}`) carrying every potential ACTIVE automation per event. Draft/Obsolete Flows and active:false rules/processes are omitted from per-event `soe` and listed once in `inactiveConfigured` when present. Each per-event payload mirrors `what_happens_on_save`: phase + stepIndex + componentId/Type/apiName + optional `firesWhen` ConditionalContext + actions array. Use this to render the full lifecycle map; use `what_happens_on_save` when the caller knows the specific DML event to focus on. Honesty axis (verbatim): conditions ARE listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them. Workflow field updates can re-fire before/after-update triggers; the composition lists each automation once. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    inputSchema: ORDER_OF_EXECUTION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_flow',
    description:
      "Given a Flow canonical id (`Flow:{ApiName}`), return a structured narrative payload that the caller (Claude / an explainer skill) composes into a natural-language explanation. The payload covers: identity (apiName, label, status, processType), trigger info (triggerType, the resolved `triggersOn` CustomObject, and the list of v2.0a `firesWhen` ConditionalContexts gating the trigger), action calls (outgoing `callsApex` edges with each target's ApexClass id + type), record lookups (outgoing `readsFrom` edges collapsed by target object with per-object filter counts), record writes (outgoing `writesTo` edges classified by `operation` into `create | update | delete`), and decisions (the v2.0a `properties.conditions[]` mirror surfaced one row per condition with the rendered expression text). A `conditionsRuntimeNote` flags that the trigger/decision conditions are the statically-declared criteria (heuristic), NOT a runtime trace — whether a path executes is data-dependent and is not evaluated. The tool does NOT compose prose — see the `disclosure` field. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: EXPLAIN_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_apex_method',
    description:
      "Given an ApexClass or ApexTrigger canonical id (`ApexClass:{ClassName}` or `ApexTrigger:{TriggerName}`), return a structured narrative payload for the explainer. The payload covers: identity (apiName, type, status, apiVersion, modifiers, lineCount, sourceBytes), the v1.5 async classifiers (`isQueueable`, `isSchedulable`, `isBatchable`, `hasFutureMethod`, `hasInvocableMethod`, `hasAuraEnabledMethod`, `isRestResource`), the v1.5 `isTest` flag, every outgoing `callsApex` edge (target id + target ApiName), every outgoing field-access edge (`readsFrom` and `writesTo` merged into one `fieldAccess` row per field with `accessType: 'read' | 'write' | 'both'`; field accesses whose receiver is an Apex `this`/`super` member or an un-type-resolved local variable are segregated into `unresolvedFieldAccess` as raw `receiver.field` tokens — NOT real object fields, mirroring `unresolvedCallTargets` for calls), and the v2.1 R2 `qualityIssues` property mirror — the structured findings (`rule` / `severity` / `location` / `explanation`, the same objects `governor_limit_risks` / `code_quality_audit` surface), empty array when the vault pre-dates v2.1. `methodName` is accepted but surfaced verbatim — v2.0f operates at class level; method-level granularity is deferred to v2.7. Honesty axis: `Structured narrative; Claude composes prose`. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: EXPLAIN_APEX_METHOD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.explain_formula',
    description:
      "Tokenize a Salesforce formula expression and return a structured narrative payload for the explainer. Accepts EITHER `formulaExpression` (an inline formula string) OR `fieldId` (a canonical CustomField id, e.g. `CustomField:Account.AnnualRevenue__c`): when `fieldId` is supplied the handler looks the field up in the vault graph, extracts its `formula` property, and runs the existing explain logic — `parentObjectApiName` defaults to the object inferred from the id (overridable). Returns `component-not-found` when the field has no formula (stored/writable field) or is not in the vault; returns `invalid-query` when neither input is supplied. The payload covers: every function call the formula uses (with a hand-curated one-line signature description per the vendored Formula.md), every field reference the tokenizer extracts (with `path` carrying the raw text and `toId` resolved against `parentObjectApiName` for single-segment refs — null when no parent context is supplied for an unscoped ref), literal counts (one row per counted numeric / string literal; v0.2's tokenizer counts but doesn't extract values, so `value` is `null`), a `hasConditionalLogic` flag (true when IF / CASE / AND / OR / NOT appear), and the maximum parenthesis nesting depth as a complexity signal. Invalid formulas DO NOT raise an error envelope — `parseError` is set in the response alongside the partial structure (the nesting-depth counter runs independently of the tokenizer). Pass `format: 'vr-draft'` to also get a `vrDraft` — a before/after Validation-Rule edit scaffold around the resolved expression (the VR's `errorConditionFormula`): `before` carries the formula verbatim, `after` is `proposedExpression` (optional) or a verbatim copy of `before` to edit, and the optional `errorMessage` is echoed into both sides. It PROPOSES a draft to feed Gearset/Copado and never fetches the VR, validates the formula, or writes to the org (see the vrDraft `disclosure`).",
    inputSchema: EXPLAIN_FORMULA_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unused_fields_deep',
    description:
      "v2.4 deep-hygiene tool: optional `objectId` narrows the scan to one CustomObject — accepts the canonical id (`CustomObject:Account`) or a bare api name (`Account`); without it the scan is org-wide. Legacy `parentObjectFilter` (bare api name) is still accepted for back-compat. Scans every CustomField in scope with an eight-tier cross-walk before flagging it as unused: (1) zero incoming usage edges (excluding parentOf containment and grantedBy FLS grants — access is not usage), (2) no formula-text reference in another CustomField / ValidationRule / WorkflowRule, (3) no layout placement (layoutSections + relatedLists), (4) no SOQL-string match in an ApexClass / ApexTrigger source byproduct, (5) no apex-scanner unresolvedFieldReferences match, (6) no incoming LWC/Aura/VF `references` edge, (7) no v2.0a ConditionalContext expression-text reference, (8) no v1.5 `exposes` integration edge. Returns per-field checks, a per-tier invisibility warning list, a confidence tier (`high` for clean+custom+non-managed; `low` for standard/managed), and a recommendedAction. `limit` (default 100, max 500) caps the rows; because each carries the full eight-tier detail, a per-response ~36 KB byte budget trims the page further when it would exceed the global ~45 KB MCP response limit (`truncated` + a `note`), while `totalCount` / `byParentObject` / `byConfidence` keep the UNFILTERED counts; a truncated page returns a `nextCursor` to resume. Honesty axis (verbatim): dynamic SOQL, LWC dynamic field access, Apex reflective access, and runtime metadata references remain invisible — a 'high-confidence unused' flag means 'no static evidence of use', not 'definitely unused'.",
    inputSchema: UNUSED_FIELDS_DEEP_INPUT_SCHEMA,
  },
  {
    name: 'sfi.process_builder_migration_candidates',
    description:
      "v2.4 legacy-automation tool: list active Process Builder (Flow with `processType: 'Workflow'`), WorkflowRule, and ApprovalProcess nodes as migration candidates with per-rule complexity ('simple' / 'moderate' / 'complex') and a migration-notes paragraph. Defaults: `activeOnly: true` (inactive rules are deletion candidates surfaced by `sfi.unused_components`), `includeWorkflowRules: true`, `includeApprovalProcesses: true`, `sortBy: 'complexity'` (easy migrations first). Complexity is heuristic based on edge counts, criteria-item count, and time-trigger presence. Honesty axis (verbatim): the migration tool itself (Setup → Migrate to Flow) does not run here — this tool produces the inventory. Complexity classification may rank a single-decision rule as 'simple' even when its business logic requires manual rewrite. When a list is large, ONE list is paged via `nextCursor` and the other two are disclosed by full count + `otherSections`; `scanTruncated` flags a >500-node type scan.",
    inputSchema: PROCESS_BUILDER_MIGRATION_CANDIDATES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.unassigned_permission_sets',
    description:
      "v2.4 hygiene tool: list PermissionSets unassigned to users. The tool ships TWO output paths: (1) when v1.7 R2 Tooling-API enrichment has run, reads `properties.assignedUserCount` as the authoritative answer (PermissionSets with count 0 surface in `unassigned[]`); (2) when enrichment has not run, falls back to a structural check — PermissionSets with no outgoing `grantedBy` edges surface as `orphanedFromComponents[]`. The `unassignedCount` field counts confirmed unassigned; `unknownAssignmentCount` separately tallies PermissionSets where assignment cannot be determined. `enrichmentStatus` reports which path the answer came from (`tooling-api-fresh` / `tooling-api-stale` / `structural-only` / `no-assignment-data`). Honesty axis (v2.4 constitutional): NEVER counts unknownAssignmentCount toward unassignedCount — separates 'no data' from 'no assignments'. When the vault holds a captured permission-holder aggregate (`refresh --with-data-shape`), the response embeds a `dataShape` holders block (`data_snapshot`, COUNTS ONLY — no identities): a container absent from the org-wide aggregate had FACTUALLY zero active assignments at the capture stamp, upgrading the metadata inference.",
    inputSchema: UNASSIGNED_PERMISSION_SETS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.empty_queues_and_groups',
    description:
      "v2.4 hygiene tool: list Queue and Group nodes with zero members. Walks `properties.memberCount` (the v1.1+ extractor convention) and falls back to `properties.queueMembers` / `properties.groupMembers` array length. The 'routing trap' case — a Queue with zero members but multiple incoming AssignmentRule references — surfaces with `incomingAssignmentRuleCount > 0`; admins must reassign routing before deletion. The `isLikelyStale` flag combines zero members + incoming refs + `lastModifiedAt > 180 days`. Member resolution that cannot decide ('unknown') is counted in `unknownMemberCountQueues` / `unknownMemberCountGroups`, NEVER toward emptiness. Honesty axis (verbatim): runtime membership changes via the Setup UI since the last vault refresh are not reflected.",
    inputSchema: EMPTY_QUEUES_AND_GROUPS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tech_debt_score',
    description:
      "v2.4 composite: aggregate the v2.0b unused_components, v2.4 unused_fields_deep / process_builder_migration_candidates / unassigned_permission_sets / empty_queues_and_groups, v2.1 qualityIssues data (when present), v1.7 freshness data (when present), and the Apex API-version distribution into one weighted 0-100 score plus a category breakdown. Score direction is INVERTED — higher means MORE debt (worse), with bands low (0-25), moderate (26-50), high (51-75), critical (76-100). Default weights: deadWeight 0.20, legacyAutomation 0.20, codeQuality 0.15, freshness 0.15, apiVersions 0.15, unassignedGrants 0.15. Categories whose underlying extractor has not run are EXCLUDED via `excludedCategories[]` (with reason 'extractor-not-run' or 'user-opted-out'), never assumed to be zero — the Q115 honesty anchor. When the codeQuality axis contributes, `boundaries[]` cites that its input is the heuristic Apex scanner (confidence: heuristic), so that axis is read as indicative, not exact (P10-A4). Pass `weights` to re-weight any subset. Pass `excludeCategories` to opt out of a category. Surfaces top-5 `recommendedActions` ordered by contribution. When `meta/risk-scores.jsonl` holds a prior refresh's score (the CLI logs the score at refresh time — snapshots can't be re-scored on demand), the response also carries `scoreDelta` / `previousScore` / `previousRefreshedAt`: the signed change in tech-debt vs the prior refresh (P9-risk-delta; positive = debt grew).",
    inputSchema: TECH_DEBT_SCORE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.code_quality_audit',
    description:
      "v2.1 R3 general-purpose code-quality entry point. Walks every ApexClass / ApexTrigger / Flow node, reads each node's `properties.qualityIssues[]` array (populated by the v2.1 `code-quality-patterns` recognizer family at extraction time), applies optional severity and rule filters, and returns the matching issues sorted by severity DESC then componentId ASC. Each issue carries `componentId` / `type` / `apiName` plus the recognizer's `rule` / `severity` / `location` / `explanation` / `confidence: 'heuristic'`. `summary` reports the FULL per-severity / per-rule / per-type counts (not the truncated slice). `severityFilter: 'all'` is the default; specific severities (`critical` / `high` / `medium` / `low` / `info`) narrow the slice. `ruleFilter: ['soql-in-loop', 'dml-in-loop']` narrows to specific rule ids. `limit` defaults to 100 (max 500); `truncated` flips true when matches exceed `limit`. CR-22: a truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so findings on a node past 500 are reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — false positives are expected; static recognition has dynamic blind spots (dynamic SOQL, reflective field access invisible) — the `dynamic-apex` info rule now FLAGS the classes that use those constructs so the blind spot is visible (impact/usage/dead-code results for them may be incomplete); severity is industry-consensus, not per-org overridable in v2.1.",
    inputSchema: CODE_QUALITY_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.governor_limit_risks',
    description:
      "v2.1 R3 Apex-specific narrowing for governor-limit-relevant patterns — the performance/scale subset of the v2.1 quality catalog. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, filters to the three governor-limit rules (`soql-in-loop`, `dml-in-loop`, `database-upsert-no-options`), groups findings by class, and (when the class is the target of an incoming `callsApex` edge from an ApexTrigger) surfaces the trigger callers in `triggerContext`. Each class entry also carries `entryPaths` (P4-graph-sast): the entry-point PATHS that reach the risky class, each an ordered `[entryPoint, ..., thisClass]` walked backwards over incoming `callsApex` to an ApexTrigger / Flow (or the top of the Apex chain) — so a finding cites WHERE it runs from (e.g. a SOQL-in-loop reachable only from a test class is lower real-world risk than one on a trigger's hot path). Bounded (depth 6, 12 paths), cycle-safe. Each class entry carries its identity, a per-finding list, the trigger context, and the entry paths. `totalRiskCount` / `byRule` report the FULL pre-slice counts. `limit` defaults to 100 (max 500); the slice is over CLASSES, not individual findings. CR-22: a truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so a risky class past node 500 is reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — static SOQL/DML inside a static method called from a loop is invisible; trigger-context callers are listed without per-edge confidence (use sfi.find_apex_usages for the per-edge detail). Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when any scanned class uses dynamic Apex — a SOQL/DML hidden inside a `Database.query(...)` string is invisible to this static recognizer, so the risk list may be incomplete.",
    inputSchema: GOVERNOR_LIMIT_RISKS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_hardcoded_values',
    description:
      "'find me hardcoded IDs / emails / usernames / endpoint URLs / sandbox-test-data' surface. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, narrows to the five hardcoded-literal rules (`hardcoded-id`, `hardcoded-email`, `hardcoded-username`, `hardcoded-url`, `hardcoded-sandbox-test-data`), and emits each match with the parent component's identity plus the recognizer's `rule` / `severity` / `location` / `explanation` plus an `inTestClass: boolean` flag (true when the parent ApexClass has `properties.isTest === true`). Optional `category` ('id' / 'email' / 'username' / 'url' / 'sandbox-data') narrows to one literal family. The `hardcoded-url` rule is namespace/domain-aware: it flags external endpoint URLs baked into Apex (should be a Named Credential / Remote Site Setting) but SKIPS Salesforce platform domains (My Domain, Sites, Visualforce, the API host). `byCategory` reports the FULL per-category counts; `limit` defaults to 100 (max 500). CR-22: a truncated page returns an opaque `nextCursor` (echo back as `cursor`) to walk the rest; the scan now windows past the per-type cap so a finding on a node past 500 is reachable (not dropped). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): pattern recognition is heuristic — managed-package embedded literals may surface as false positives; the refusal-pattern disclosure 'string literals inside @isTest classes that look like IDs may be intentional test fixtures' is appended verbatim when ANY surfaced match is in a test class. (Takes effect on ApexClass/ApexTrigger refreshed after this rule shipped.)",
    inputSchema: FIND_HARDCODED_VALUES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.crud_fls_audit',
    description:
      "v2.1 R3 CRUD/FLS enforcement audit. Walks every ApexClass / ApexTrigger node's `properties.qualityIssues[]`, narrows to the two CRUD/FLS rules (`missing-crud-check`, `missing-fls-check`), groups findings by class, and surfaces the verbatim Q80 disclosure naming the HIGH false-positive rate inherited from ApexQualitySemantics.md §§ 6-7. Each class entry carries its identity and a per-finding list (rule / severity / location / explanation). `totalFindingCount` / `byRule` report the FULL pre-slice counts. The class list is paginated: `limit` defaults to 100 (max 500) and `offset` (default 0) page over CLASSES, and a per-response ~36 KB byte budget trims the page further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more classes remain, with `nextOffset` to advance (plus a `note` when byte-trimmed, and a per-class `findingsTruncated` flag in the rare case one class's findings alone overflow). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one finding qualifies): the Q80 false-positive disclosure — 'custom security utility methods are invisible to the recognizer; this finding may be a false positive if your org uses a helper like SecurityUtils.canCreate(account)' — is the load-bearing honesty surface for this tool. Also surfaced: cross-method dataflow is invisible; dynamic SOQL strings (Database.query) are stripped before pattern passes.",
    inputSchema: CRUD_FLS_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.test_coverage_gaps',
    description:
      "v2.1 R3 test-coverage-gap surface. Combines three signals: (1) `properties.isTest === true` identifies test classes (excluded from the scan), (2) BFS over incoming `callsApex` edges (capped at depth 3) collects the test classes reaching each non-test class, (3) `qualityIssues[]` `fake-assertion` findings on those test classes mark meaninglessly-covered classes. Classifies each non-test ApexClass into one of three coverage statuses — `uncovered` (no test reaches it within depth 3), `fake-coverage` (covered, but EVERY covering test has fake-assertion findings), `low-quality-coverage` (covered, but SOME covering test has fake-assertion findings). Each gap entry carries `componentId` / `apiName` / `coverageStatus` / `coveringTestClassIds[]` / `fakeAssertions[]` / `recommendedAction`. `byStatus` reports the per-status counts. The gap list is paginated: `limit` (default 200, max 500) and `offset` (default 0) page over gap entries, and a per-response ~38 KB byte budget trims the page further when a page would exceed it, so the result never trips the global ~45 KB MCP response limit; `truncated` flips true when more gaps remain, with `nextOffset` to advance (plus a `note` when byte-trimmed). Optional `classFilter[]` narrows the scan to specific ApexClass ids (capped at 500). Honesty axis (verbatim, surfaced in `boundaries[]` when at least one gap qualifies): the meaningful-assertion heuristic recognizes `System.assertEquals(expected, actual)` with distinct tokens; assertions via helper methods or framework wrappers are invisible. Reachability via `callsApex` does NOT cover dynamic dispatch. BFS is capped at depth 3.",
    inputSchema: TEST_COVERAGE_GAPS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_field_type',
    description:
      "v2.3 R2a what-if tool: given a CustomField canonical id (`CustomField:{Object}.{Field}`) and a proposed new field type, returns the structured impact across every incoming dependency edge. Classifies the (currentType, newType) transition via the matrix in WhatIfSemantics.md as `forward-compatible` / `lossy` / `breaking`, then walks every incoming edge (`references` from validation rules / formulas, `readsFrom`/`writesTo` from Flow + Apex + LWC/Aura/VF, `usedInLayout` from layouts, integration references from External Service / External Data Source) and emits per-impact entries with `category` (metadata-blocker / code-needs-update / integration-touch / configuration-only), source ComponentId, edge-level `confidence`, and a one-sentence explanation. FLS grants (Profile / PermissionSet) are NOT impacts — access keys on API name, not type — and Formula / Roll-Up Summary (computed) fields return `invalid-query` because their type is derived, not stored, so a field-type change is not a valid operation (mirrors `what_if_make_field_required`). Aggregate `verdict` is `safe` / `review` / `risky` / `blocking` based on the impact mix. Supported newType values include `EncryptedText` (Shield/Classic encryption): any transition to EncryptedText is classified as `lossy` because encrypted fields cannot be used in formulas, are invisible to SOQL filters in standard queries, and Apex/Flow reading the field without SYSTEM_MODE will receive masked values. Honesty axis (verbatim): dynamic SOQL, reflective field access via `obj.get('FieldName')`, and runtime computation are invisible; compatibility matrix is conservative — narrow data-shape edge cases may behave compatibly in practice.",
    inputSchema: WHAT_IF_CHANGE_FIELD_TYPE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_remove_picklist_value',
    description:
      "v2.3 R2a what-if tool: given a Picklist or MultiselectPicklist CustomField id (`CustomField:{Object}.{Field}`) and a value to remove, returns the structured impact across formula sources referencing the literal value, Apex classes/triggers with the value in their `properties.stringLiterals` array AND an existing readsFrom/writesTo edge to the field, Flow / WorkflowRule / ValidationRule firers whose v2.0a `firesWhen` ConditionalContext expression references the value, and downstream ConditionalContext nodes. Each impact entry carries `category` (metadata-blocker for declarative references; code-needs-update for Apex; integration-touch / configuration-only for the rest), source ComponentId, edge-level `confidence`, and a one-sentence explanation. Compatibility is `breaking` when impacts exist and `review` when none match (the value may still be touched dynamically). Honesty axis (verbatim): variable-based picklist comparisons and dynamic SOQL strings are invisible; review dynamic comparisons separately before removing the value.",
    inputSchema: WHAT_IF_REMOVE_PICKLIST_VALUE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_make_field_required',
    description:
      "v2.3 R2a what-if tool: given a CustomField id (`CustomField:{Object}.{Field}`), walks the parent object's write paths and flags incomplete writes that would fail at runtime once the field is required. Surfaces: layouts on the parent that do NOT display the field (`category: 'configuration-only'`); Flows creating records on the parent object that do NOT set the field via `recordCreate` (`category: 'metadata-blocker'`); External Service / External Data Source integrations referencing the parent (`category: 'integration-touch'`); and (CR-CAP-01) declarative populators that DO set the field — WorkflowRule field-updates and ApprovalProcess field-updates discovered on the field's inbound `writesTo` edges — surfaced as informational `configuration-only` findings. Those populators are CONDITIONAL (a WorkflowRule fires only on criteria match; an ApprovalProcess field-update fires only on a specific hook and only for records that go through approval), so they NEVER move the verdict to `safe` — they document a partial mitigation to verify, not a guarantee of population. When the field is already required (`properties.required === true`), returns a no-op `safe` verdict with empty impacts. NOT walked: Apex `insert acc;` sites — determining whether `acc.Industry__c` was assigned before the insert requires dataflow analysis (deferred per WhatIfSemantics.md). Honesty axis (verbatim, surfaced ALWAYS): the analysis checks layouts (UI input paths), Flow create paths, integration write surfaces, and declarative populators (Flow / Workflow / Approval field-updates) that may set the field — conditional writers do not guarantee population; Apex insert sites that may or may not set the field are invisible. HYBRID (P6-required-field-whatif): pass `liveEnabled: true` (or grant consent) to add `liveNullRate` — the live production null-rate for the field (how many existing records have it NULL today, with a plain-language reading of what making it required means for that population), plus a `staleness` lead when the org is ahead of the vault. With the live plane on, the answer's `trust.provenance` is `hybrid` (both planes' freshness); without it, the offline verdict stands unchanged. When the vault holds captured data-shape facts, the response embeds the field's sampled fill rate as a stamped `data_snapshot` `dataShape` block — CONTEXT ONLY: the verdict never softens on a sampled observation.",
    inputSchema: WHAT_IF_MAKE_FIELD_REQUIRED_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_deactivate_flow',
    description:
      "v2.3 R2b component-level what-if tool: given a Flow canonical id (`Flow:{ApiName}`), bare API name, or flow label / partial name (e.g. 'Consent Flow'), enumerates the downstream impact of deactivating the Flow by walking every outgoing edge. When a non-canonical input is passed, the tool performs an internal fuzzy lookup (resolveComponents filtered to Flow type): if exactly one match is found it auto-resolves; if multiple candidates match it returns them for the caller to pick from; if none match it returns a helpful error with a hint to use sfi.list_components. Surfaces `triggersOn` (the object the Flow listens to), `readsFrom` / `writesTo` (record lookups + DML), `callsApex` (Apex action calls the Flow made), and `sendsEmail` (email templates the Flow sent) as `WhatIfImpactItem` entries with category, source ComponentId, edge-level `confidence`, and a one-sentence explanation. The response also carries the Flow's current `firingConditions` (the v2.0a `firesWhen` ConditionalContext list — the gating conditions the deactivation would silence). Aggregate `verdict` is `safe` (no impacts) / `risky` (callsApex only) / `blocking` (any record write, trigger, or email-send impact). Honesty axis (verbatim): deactivation does NOT delete the Flow — its definition remains and a later reactivation restores every effect listed; Apex code that conditionally invokes the Flow via Flow.Interview or @InvocableMethod chains is invisible to the heuristic walker.",
    inputSchema: WHAT_IF_DEACTIVATE_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_disable_trigger',
    description:
      "v2.3 R2b component-level what-if tool: given an ApexTrigger canonical id (`ApexTrigger:{Name}`), enumerates the downstream impact of disabling the trigger by walking every outgoing edge. Surfaces `triggersOn` and `listensTo` (the parent SObject and Platform Event subscription), `writesTo` and `readsFrom` (field access from the trigger body — heuristic via the v0.3 apex-scanner), `callsApex` (Apex classes the trigger invokes), and `dispatchesAsync` (async jobs the trigger queues) as `WhatIfImpactItem` entries. The response also carries the trigger's `parentObject` (the SObject the trigger attaches to) and `events` (the lifecycle phases: `before insert`, `after update`, etc.) as scalar fields so the renderer can render \"automation on Account will lose this handler\". Aggregate `verdict` follows the same cascade as `what_if_deactivate_flow`. Honesty axis (verbatim): disabling is a runtime metadata flag, not a deletion; the v0.3 apex-scanner's edge confidence is heuristic — spot-check the trigger body when a finding's confidence is heuristic. Indirect dispatch via trigger framework base classes (TriggerHandler, fflib) may be partially invisible to the recognizer.",
    inputSchema: WHAT_IF_DISABLE_TRIGGER_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_change_method_signature',
    description:
      "v2.3 R2b component-level what-if tool: given an ApexClass id (`ApexClass:{Name}`), a method name, and an optional new signature string, enumerates every direct caller of the named method plus every test class exercising the target class. Walks incoming `callsApex` edges filtering by `properties.methodName === methodName` (Flow callers are accepted without methodName matching — Flow XML declares the action name at class level), then walks incoming `coversTest` edges. Each caller surfaces in `callingClasses[]` as a `WhatIfImpactItem` with `category` (`code-needs-update` for non-test code callers; `test-class-update` for test classes), source ComponentId, edge-level `confidence` (`heuristic` for the apex-scanner / Visualforce callers; `parsed` for Flow callers parsed out of the Flow `<actionCalls>` XML; `declared` for LWC/Aura `@salesforce/apex/{Class}.{method}` imports), and a one-sentence explanation. Test classes also surface in a parallel `testClassesNeedingUpdate[]` scalar array. The `newSignature` parameter is accepted for renderer context and echoed verbatim in the response — the tool does NOT parse it. Aggregate `verdict` is `safe` (no callers) / `risky` (callers present — every caller is flagged for human review since v2.3 lacks an Apex AST). Honesty axis (verbatim, surfaced ALWAYS): caller confidence varies by source — Apex/Visualforce callers are heuristic apex-scanner output, Flow callers are parsed from the <actionCalls> XML, LWC/Aura callers are declared via the @salesforce/apex import; dynamic dispatch via Type.forName + invoke is invisible. Test classes are identified by @isTest + naming convention (className + 'Test' suffix) and by coversTest edges; a test class that doesn't follow the naming convention and doesn't carry a @TestVisible-tagged covering reference may be missed.",
    inputSchema: WHAT_IF_CHANGE_METHOD_SIGNATURE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_merge_profiles',
    description:
      "v2.3 R2c profile what-if tool: given two Profile canonical ids (`Profile:{Name}`), walks both profiles' grants and visibility settings, groups them by `(settingType, settingId)`, and surfaces every pairwise disagreement as a `MergeConflict` carrying `profileAValue`, `profileBValue`, and a `recommendedPolicy` (`max` for permission ladders / Boolean OR semantics; `min` for clamp-down merges; `manual-only` for categories with no clean comparator such as layout assignments). Setting categories covered: user permissions (from `properties.userPermissions`), object permissions, field permissions, apex class access (the three `grantedBy`-edge categories), tab visibilities (`properties.tabVisibilities`), layout assignments (`properties.layoutAssignments`), and record type visibilities (`properties.recordTypeVisibilities`). The `summary` carries `totalSettings`, `agreed`, `conflicts`, and `notEvaluatedCategories` counts. Honesty axis (verbatim): v2.3 surfaces conflicts but does NOT auto-resolve — recommended policies are heuristic; manually verify each conflict before applying. Profile-edition rollup (e.g., admin-level overrides) is not modeled. Tab visibility is compared ONLY when the refresh extracted `properties.tabVisibilities` — the Profile extractor emits it at every refresh, so it is normally compared; a profile from a vault refreshed before the P11 extraction lacks it, and the category is then listed in `summary.notEvaluatedCategories` with a disclosure rather than reported as a fabricated 'no tab conflicts' (remedy: re-run `/sfi-refresh`).",
    inputSchema: WHAT_IF_MERGE_PROFILES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.what_if_split_profile',
    description:
      "v2.3 R2c profile what-if tool: given a Profile id (`Profile:{Name}`) and an ordered array of target PermissionSet ids (`PermissionSet:{Name}`), proposes a per-grant assignment via a greedy keyword-match heuristic. For each grant (user permission, object permission, field permission, apex class access): Step 1 tokenizes both the target perm-set names and the grant's settingId on camelCase + underscore + dash boundaries and assigns to the highest-overlap target (`rationale: 'keyword-match'`); Step 2 falls back to a domain-cluster match on the parent object name (`rationale: 'domain-cluster'`); Step 3 falls through to the FIRST target as the user-provided default (`rationale: 'default'`). Grants where even Step 3 cannot apply (defensively reachable when target list edge cases occur) surface in `unassignedSettings[]` with a reason — the v2.3 fail-conservative posture surfaces unassignable grants rather than forcing them into an inappropriate target. Layout assignments, tab visibilities, and record-type visibilities are NOT split (Profile-only settings in the Salesforce metadata model). Honesty axis (verbatim): v2.3 split clustering is approximate; the greedy keyword-match heuristic is fail-conservative — review every assignment before applying.",
    inputSchema: WHAT_IF_SPLIT_PROFILE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_data_dictionary',
    description:
      "v2.5 documentation-generation tier: given a CustomObject (the `objectId` accepts either the canonical id `CustomObject:{ApiName}` or a bare object api name like `Account`, coerced to the id — consistent with `generate_sharing_summary`), composes a structured markdown document covering the object's Overview, Fields (table with label/api-name/type/description/required), Relationships (lookups + master-details), Validation Rules, Page Layouts (via incoming `usedInLayout` edges), and Related Triggers/Flows (via incoming `triggersOn` edges). Returns a `GeneratedDocument` payload — frontmatter (title, generatedAt, sourceTreeHash, componentIds), body (the rendered markdown), `sectionConfidence` keyed by heading, and a `boundaries` footer carrying the verbatim Q125 freshness disclosure + the structural / inherited-confidence disclosures. Honesty axis: document is structure, not narrative; downstream rendering layer composes prose. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: GENERATE_DATA_DICTIONARY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_admin_handbook',
    description:
      "v2.5 documentation-generation tier: composes a structured markdown admin handbook covering the org's purpose, main objects, automation summary, permission structure, integration topology, and recent changes. Optional `personaFocus` (`'admin' | 'architect' | 'business-user' | 'developer'`, default `'admin'`) reshuffles section ordering — `'developer'` leads with main objects, automation summary, and a Codebase Footprint subsection; `'architect'` leads with Integration Topology. Returns a `GeneratedDocument` payload. Honesty axis: Recent Changes depends on v1.7 enrichment — when absent the section surfaces a verbatim enrichment-command disclosure rather than fabricating activity.",
    inputSchema: GENERATE_ADMIN_HANDBOOK_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_architecture_overview',
    description:
      "v2.5 documentation-generation tier: composes a 3-4 page architecture document chaining `sfi.org_overview` + `sfi.domain_clusters` + `sfi.integration_map`. Body covers Executive Summary, Org Structure (mermaid diagram with top objects), Domain Clustering (mermaid + table of suggested clusters), Integration Topology (mermaid + tally table), Automation Footprint, and Codebase Footprint. Returns a `GeneratedDocument` payload; pass `format: 'html'` to ALSO get a self-contained `html` page (renders the markdown + mermaid diagrams client-side) to save as a `.html` artifact. Honesty axis: domain clusters and top-object rankings inherit heuristic confidence from the upstream composition tools — surfaced as suggested starting points, not authoritative groupings.",
    inputSchema: GENERATE_ARCHITECTURE_OVERVIEW_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_sharing_summary',
    description:
      "v2.5 documentation-generation tier: composes a structured markdown sharing summary covering every CustomObject's OWD (`properties.sharingModel`), the SharingRules that apply (matched on `properties.sObjectType`), the Profile / PermissionSet grants tallied from incoming `grantedBy` edges on the object's children, and the Role Hierarchy (mermaid diagram from Role node `properties.parentRoleId`). Optional `objectFilter` (string api name) narrows the scan to one CustomObject; default scans every extracted object (capped at 50). Returns a `GeneratedDocument` payload. Honesty axis: Role-hierarchy data depends on v1.1 sharing extractors having processed `roles/` metadata; absent role nodes surface a disclosure rather than an empty diagram. B29: when `objectFilter` names an object that matched no RETRIEVED CustomObject but IS referenced elsewhere (inbound edges — a phantom from a managed package or outside the retrieve scope), the response carries a structured `targetMissing { id, referencedBy }` and the body discloses \"not retrieved\" rather than a silent \"no objects matched\" — so an FLS/sharing review is never handed an empty answer that reads as \"no sharing\".",
    inputSchema: GENERATE_SHARING_SUMMARY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_compliance_report',
    description:
      "v2.5 documentation-generation tier: composes a structured markdown compliance report chaining `sfi.pii_inventory` + `sfi.field_access_audit` (per top-PII-field, capped at 25) + per-object `sharingModel` lookup. Body covers Executive Summary, PII Inventory by Category (tables per category), Field Access Audit (per-field profile/perm-set grant counts), Sharing Model Exposure (OWD per parent object), and Risk Flags (PII fields with ≥3 read grants). Returns a `GeneratedDocument` payload. Honesty axis: PII classifications inherit the v2.0d recognizer's heuristic provenance — fields flagged here may not store PII at runtime, and unflagged fields may. Dynamic Apex / runtime SOQL are invisible to the access-audit.",
    inputSchema: GENERATE_COMPLIANCE_REPORT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.generate_onboarding_doc',
    description:
      "v2.5 documentation-generation tier: composes a structured markdown new-admin / new-developer tour chaining `sfi.generate_admin_handbook` + `sfi.generate_architecture_overview` + `sfi.org_overview` for top objects + a custom-field-label glossary builder (heuristic on labels appearing in fewer than 5 objects). Body covers What This Org Does, Main Data Model (top 3 objects), Common Workflows, How Security Works, Naming Conventions, Glossary, Key Contacts (or disclosure when v1.7 enrichment absent), and Where To Go Next (persona-specific tool hints). Optional `personaFocus` (`'admin' | 'developer'`, default `'admin'`). Returns a `GeneratedDocument` payload. Honesty axis: glossary entries are heuristic — a label on a single object MAY be org-specific terminology or may simply be an underused standard label. Key Contacts depends on v1.7 enrichment.",
    inputSchema: GENERATE_ONBOARDING_DOC_INPUT_SCHEMA,
  },
  // v2.7 R2 — deep code understanding tier (call-graph / downstream-effects /
  // test-coverage-for-method / meaningful-test-audit / method-reachability).
  // All five operate at CLASS granularity; method-level edge resolution is
  // deferred to v2.7.1.
  {
    name: 'sfi.call_graph',
    description:
      "Deep code tool: given a root `ApexClass:` or `ApexTrigger:` id and an optional `direction` (`'downstream' | 'upstream' | 'both'`; defaults to `'both'`), BFS over `callsApex` edges up to `maxDepth` hops (default 3, max 5). Returns the discovered nodes (each labelled with the shortest-path hop count from the root), the traversed edges — each carrying `methods` (the methods of the target class the source invokes, P4-C5) — a `cycleDetected: boolean`, the `maxDepthReached`, and the disclosure. The optional `method` arg narrows the root's DIRECT edges to those involving that method, e.g. `direction:'upstream' + method:'deleteRecord'` answers \"who calls Root.deleteRecord\" (deeper hops are unfiltered). Cycle detection is keyed by node id; a back-edge during the walk flips the flag without aborting. Both-direction walks dedupe overlapping nodes/edges. Honesty axis (verbatim): method-level call TARGETS are surfaced, but the CALLER-side method (which method of the source does the calling) is NOT partitioned — that needs full AST analysis, so edges stay heuristic. Invalid prefix surfaces as `invalid-query`; unknown root resolves to an empty walk (root-only response, NOT an error envelope).",
    inputSchema: CALL_GRAPH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.downstream_effects',
    description:
      "v2.7 R2 deep code tool: given an `ApexClass:`, `ApexTrigger:`, OR `CustomObject:` id, surfaces what downstream automation and side effects are reachable. **Apex root** (`ApexClass:`/`ApexTrigger:`): walks downstream `callsApex` BFS (capped at `maxDepth`, default 3, max 5) then for every reachable class surfaces its outgoing `writesTo` (`category: 'field-write'`), `dispatchesAsync` (`category: 'async-dispatch'`), and `sendsEmail` (`category: 'email'`) edges as categorised side effects. Optional `method` narrows the root's DIRECT outgoing `callsApex` edges to those whose `methods[]` (P4-C5) include that target method — e.g. `method: 'deleteRecord'` follows only callees invoked via `deleteRecord` from the root (deeper hops unfiltered). **Object root** (`CustomObject:`): discovers automation via incoming `triggersOn` (ApexTrigger, Flow, WorkflowRule) and outgoing `parentOf` (ApprovalProcess — parented on the object, no `triggersOn`), returning them in `automationNodes[]`; for each firer collects direct declarative effects (`writesTo` / `sendsEmail` / `dispatchesAsync` on the firer node) plus Apex effects reachable via `callsApex` BFS (workflow/approval/flow Apex actions and trigger handlers) into the same `effects[]` slice — answers \"what automation runs on this object and what does it do\". Each effect carries the source id/apiName, the target id/type/apiName (when resolvable), the producing edge type and source. `summary` reports per-category counts across the slice. Honesty axis (verbatim): optional `method` filters target methods on the root hop only — the CALLER-side method (which method of the root body performs each call) is NOT partitioned; HTTP callouts are NOT a v2.7 effect category — only the v1.5 / v1.3 extractor-emitted edges count; Apex email (`Messaging.sendEmail`) and DML deletes are likewise invisible, so an EMPTY effects list means \"no MODELED effects\" — never \"side-effect-free\" (the disclosure says so explicitly on empty results). Invalid prefix surfaces as `invalid-query`; unknown root surfaces as `component-not-found`.",
    inputSchema: DOWNSTREAM_EFFECTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.test_coverage_for_method',
    description:
      "Deep code tool: given an `ApexClass:` or `ApexTrigger:` id and an optional `methodName`, walks upstream `callsApex` + `dispatchesAsync` BFS (capped at depth 3) and surfaces every test class (nodes with `properties.isTest === true`) that reaches the target. Each `coveringTestClasses` entry carries the test class id, apiName, and shortest-path depth. **P4-test-reachability:** when `methodName` is supplied, each covering test ALSO carries `exercisesMethod` — true when its shortest reaching path enters the target via a `callsApex` edge whose `methods[]` (P4-C5) includes that method, i.e. the test actually exercises the CHANGED method, not just the class — and the payload carries `methodCoveringCount` (tests with `exercisesMethod === true`; `null` for a class-level query). So a changed method names the test(s) that cover IT. Heuristic + shortest-path (a method reachable only via a longer alternate path may read false; `dispatchesAsync` hops carry no method index); `methods[]` populates on vaults refreshed after P4-C5, older vaults fall back to the scalar `methodName`. The depth-3 cap and dynamic-dispatch invisibility surface verbatim in `disclosure`. Invalid prefix surfaces as `invalid-query`; unknown target surfaces as `component-not-found`. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when the analyzed class uses dynamic Apex, since reflective invocation can make the test→method mapping incomplete.",
    inputSchema: TEST_COVERAGE_FOR_METHOD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.meaningful_test_audit',
    description:
      "v2.7 R2 deep code tool: lists every ApexClass with `properties.isTest === true` with a heuristic assertion-meaningfulness score. Each `tests[]` entry carries `assertionCount` (from `properties.assertionCount` when the v2.1 R2 recognizer ran; 0 otherwise), `fakeAssertionCount` (count of `qualityIssues[]` entries with `rule === 'fake-assertion'`), `sourceBytes`, a per-KB `density` metric, and the verbatim per-test fake-assertion locations for follow-up triage. Ranking: `fakeAssertionCount` DESC, then `density` ASC (sparse asserts surface higher). Optional `classFilter` narrows to specific ApexClass ids. Honesty axis (verbatim): `assertionCount` counts `System.assert*` and the modern `Assert.*` class; the fake-assertion recognizer is still scoped to `System.assertEquals` shapes — helper methods (`MyTestHelper.assertField`) and framework wrappers are invisible to both. A test with high fakeAssertionCount MAY actually have meaningful tests via a custom assertion helper.",
    inputSchema: MEANINGFUL_TEST_AUDIT_INPUT_SCHEMA,
  },
  {
    name: 'sfi.method_reachability',
    description:
      "v2.7 R2 deep code tool: given an `ApexClass:` or `ApexTrigger:` id, walks upstream `callsApex` BFS (capped at depth 3) and classifies the reachable upstream set against the entry-point taxonomy: `ApexTrigger` (any), `ApexClass` with `properties.isRestResource === true` (REST), `properties.hasAuraEnabledMethod === true` (Aura), `properties.hasInvocableMethod === true` (Flow / Process Builder), or any of `properties.isQueueable` / `properties.isBatchable` / `properties.isSchedulable` (async dispatch). Verdict cascade: `entry-point-reachable` (at least one entry point reaches the target), else `test-only-reachable` (at least one test class reaches it), else `likely-dead-code` (neither). Honesty axis (verbatim): dynamic dispatch (Type.forName) and reflective invocation are invisible — a class genuinely invoked at runtime via reflection will surface as `likely-dead-code`. Trigger framework base classes (TriggerHandler, fflib) may be partially invisible. Invalid prefix surfaces as `invalid-query`; unknown target surfaces as `component-not-found`. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when the analyzed class uses dynamic Apex, since a reflective caller can make the reachability verdict wrong.",
    inputSchema: METHOD_REACHABILITY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.tests_for_change',
    description:
      "Smart test selection (test-impact analysis): given `changedComponents` (1..500 ApexClass / ApexTrigger ids or bare class names), returns the MINIMAL set of test classes to run plus the inverse risk signal — changed components no test reaches. For each changed Apex component, BFS upstream over INCOMING `callsApex` AND `dispatchesAsync` edges (depth-3 capped, same as `sfi.test_coverage_for_method`) and collects every reached `properties.isTest === true` node. `selectedTests` is the union (each entry carries `minDepth` and the `coversChanges` ids it exercises). `perChange` reports per-component coverage; `uncoveredChanges` lists changed non-test classes NO test reaches (the unguarded surface). A changed component that is itself a test class is added at depth 0 (run it directly) and never counted as uncovered. Non-Apex `Type:` prefixes bucket into `unsupportedChanges`; well-formed-but-absent Apex ids bucket into `notFoundChanges` — neither fails the batch. Honesty axis (verbatim): CLASS granularity (method-level promised v2.7.1); dynamic dispatch (Type.forName), reflective invocation, and managed-package test classes are invisible; BFS depth-3 capped — deeper coverage chains surface as uncovered. A component in uncoveredChanges is UNGUARDED — run the full suite when any change is uncovered or a deep chain is suspected.",
    inputSchema: TESTS_FOR_CHANGE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cdc_subscribers',
    description:
      "v2.8 async-deep-tier surface: given an optional `sObjectFilter` (e.g., 'Account', 'Order__c'), enumerate every ApexTrigger, ApexClass, and Flow that emits an incoming `listensTo` edge into a Change Data Capture (CDC) event. v2.8 recognizes CDC events by NAME PATTERN on the target apiName — standard objects use `{ObjectName}ChangeEvent` (no separator); custom objects use `{ObjectNameWithout__c}__ChangeEvent`. The sibling of `sfi.event_subscribers` (which handles `__e` Platform Events) — both walk the same v1.5 R3 `listensTo` edge family but filter by different target name patterns. When `sObjectFilter` is supplied the tool computes the synthetic ChangeEvent id from the filter; when omitted every CDC-recognizable event in the graph is scanned. The summary surfaces total subscribers and unique change events. Honesty axis (verbatim): CDC subscription detection here recognizes by name pattern only — `EventBus.subscribe(...)` programmatic registration is invisible, and per-channel filter expressions in `*.platformEventChannelMember-meta.xml` are not extracted.",
    inputSchema: CDC_SUBSCRIBERS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.async_chain_depth',
    description:
      "v2.8 async-deep-tier walker: given an ApexClass canonical id (`ApexClass:{Name}`), walks the transitive async chain via outgoing `dispatchesAsync` edges, capped at 10 hops. Returns `maxDepth` (deepest reached), `cyclesDetected` (true when a back-edge in the BFS spanning tree appears), `truncated` (true when depth 10 was hit with more nodes pending), `branchPoints` (classes with `>= 2` distinct downstream targets, sorted by branchCount DESC), and `chains` (every walked edge with its depth, sorted depth ASC then fromId/toId ASC). The `chainAsync` synthetic edge is NOT persisted to the graph — only this tool surfaces it. Honesty axis (verbatim): the v0.3 Apex scanner producing `dispatchesAsync` is heuristic; reflective dispatch (`Type.forName + invoke`) and helper-wrapper dispatch (`MyHelper.enqueue(new MyJob())`) are invisible, so the walked chain may UNDERSTATE the runtime depth. Invalid prefix surfaces as `invalid-query`; unknown but well-formed ids surface as `component-not-found`.",
    inputSchema: ASYNC_CHAIN_DEPTH_INPUT_SCHEMA,
  },
  {
    name: 'sfi.scheduled_job_catalog',
    description:
      "v2.8 async-deep-tier surface: returns one entry per ApexClass with `properties.isSchedulable === true`, with the per-class `scheduledByCalls` array surfaced from inbound `dispatchesAsync` edges whose `properties.dispatchMechanism === 'schedule'`. Each entry carries the class id, apiName, `isSchedulable: true`, the `scheduledByCalls` (caller class plus per-edge cron expression when available), and any `cronExpressions[]` property the apex-scanner populated. Takes no arguments — the catalog is intentionally org-wide. Honesty axis (verbatim): scanning for System.schedule() invocations is heuristic — the v0.3 Apex scanner detects literal call sites only, NOT runtime registration via Tooling API. A class flagged `isSchedulable: true` may not currently be scheduled; conversely, a class scheduled via a helper-wrapper or dynamic class load is invisible to the scanner.",
    inputSchema: SCHEDULED_JOB_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.outbound_message_catalog',
    description:
      "v2.8 async-deep-tier surface: returns one entry per OutboundMessage node (the v2.8 promotion of the v1.3 dangling-by-design `<outboundMessages>` references) with the endpoint URL, payload shape (fields list), integration user, the includeSessionId / useDeadLetterQueue flags, and the WorkflowRules that invoke it via incoming `references` edges. Optional `objectFilter` narrows to one parent CustomObject (e.g., 'Account'). `entriesByObject` groups entries by parent object key for renderer convenience. Honesty axis (verbatim): endpoint URLs are captured verbatim from `<outboundMessages><endpointUrl>` and NOT VALIDATED — v2.8 does not probe the URL, does not confirm the destination exists, and does not confirm the message is actually invoked at runtime.",
    inputSchema: OUTBOUND_MESSAGE_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.endpoint_catalog',
    description:
      "v2.8 async-deep-tier composite: returns every URL / endpoint participating in an integration in one structured response, split four ways — `inboundApis` (from v1.5 `exposes` edges to synthetic ExternalApi:{kind}/{path} targets; REST / Aura / Invocable), `outboundMessages` (from OutboundMessage `endpointUrl` properties), `externalDataSources` (from ExternalDataSource `endpoint` properties), and `namedCredentials` (from NamedCredential `url` properties). Each entry carries `endpointKind` discriminator, `direction` (inbound / outbound), `sourceComponentId`, and `url`. The URL-axis sibling of `sfi.integration_map` (which surfaces nodes + wiring) and `sfi.outbound_message_catalog` (which surfaces one category in depth). Takes no arguments. Honesty axis (verbatim): URLs are captured verbatim; v2.8 does NOT probe, does NOT validate, and does NOT confirm the destination exists or is reachable. Runtime registrations (e.g., a NamedCredential resolved via custom metadata at runtime) may carry a stored URL that differs from the actual production destination.",
    inputSchema: ENDPOINT_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_meaning',
    description:
      "v2.9 vocabulary + semantic-disambiguation tier — the 'what does this field actually mean in our org?' surface. Given a CustomField canonical id (`CustomField:{Object}.{Field}`), returns the field's declared shape (apiName, label, description, type, parent object, and — when present — `picklistValues` as `{ value, label, isActive }` entries where `isActive: false` marks a deactivated value that is retained-but-not-selectable and listed-and-marked rather than dropped (H10); a corresponding boundary surfaces when any value is inactive), asymmetric `usageFrequency` (incoming `readsFrom` vs incoming `writesTo` edge counts — reveals scratch-field patterns), the v2.9 `sourceOfTruth` classification (`manual` | `derived` | `integration-synced` | `manual-and-coded` | `unknown` with `declared`/`heuristic` confidence) and `semanticCategory` classification (`identifier` | `status` | `amount` | `date` | `reference` | `descriptor` | `unknown`; always `heuristic` confidence), the top-3 `similarFields` by label/apiName token overlap (v2.2's TF-IDF is the canonical source per PLAN-v2.9 §3; the lightweight overlap fallback ships here so the tool produces output independent of v2.2 presence), and a `boundaries` array surfacing the v2.9-wide honesty axes (vocabulary is org-specific; usage frequency is static analysis only; classification is heuristic on writes-fabric inference; semantic category is name-pattern, not type-semantic). When the v2.9 classifier has not populated `sourceOfTruth` / `semanticCategory` (pre-v2.9 vaults), both default to `unknown` and the classification-missing boundary surfaces. Invalid prefix → `invalid-query`; unknown id → `component-not-found`.",
    inputSchema: FIELD_MEANING_INPUT_SCHEMA,
  },
  {
    name: 'sfi.disambiguate_concepts',
    description:
      "v2.9 vocabulary + semantic-disambiguation tier — the 'is `Status` the same as `Stage` here?' surface. Takes two org-specific concept tokens (`conceptA`, `conceptB`) and returns per-concept matching-field buckets, per-axis differences (parent-object distribution, declared types, picklist-values, usage-pattern), and an optional `suggestedWhenToUseEach` inference (`null` when bucket parent-object distributions overlap — the tool refuses to fabricate distinction). A field matches a concept when (1) its apiName tokenized form overlaps the concept's tokens, OR (2) its label tokenized form overlaps, OR (3) `properties.semanticCategory.value` equals the concept (lowercased). The `boundaries` array carries the verbatim Q155 honesty anchor: 'Vocabulary is org-specific — one org's Status is another org's Stage; the tool reports what THIS org's metadata declares, not industry convention. Verify each field's label, description, and usage before treating the disambiguation as authoritative.' When `conceptA` equals `conceptB` (case-insensitive trimmed), buckets are returned identically with empty `differences` — the skill detects this and refuses to fabricate a distinction (PLAN-v2.9 Q150). Optional `limit` (1-200, default 50) caps each bucket's `matchingFields` slice.",
    inputSchema: DISAMBIGUATE_CONCEPTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_provenance',
    description:
      "v2.9 vocabulary + semantic-disambiguation tier — the 'is this field manually entered or automated?' surface. Given a CustomField canonical id, returns the v2.9 `sourceOfTruth` classification + confidence plus the full structural trace: `declaredAsFormula` (formula expression when the field has one), `declaredAsAutoNumber` (displayFormat when the field is auto-number), ALL `apexWriters` (with v2.0a `isIntegrationTagged` from outgoing `references` edges to NamedCredential / ExternalDataSource — the integration-synced classifier signal), ALL `flowWriters`, ALL `triggerWriters`, and the `noWritersDetected` boolean (false for formula / auto-number fields per PLAN-v2.9 Q151 — the declaration IS the source). The trace lists EVERY writer, not just the ones used in the classification cascade, so callers can verify the classification's basis. `boundaries` carries the verbatim 'dynamic SOQL, reflective field access, and managed-package writers may be invisible' disclosure; when classification is heuristic the additional 'classification is heuristic on writes-fabric inference' boundary surfaces. Invalid prefix → `invalid-query`; unknown id → `component-not-found`.",
    inputSchema: FIELD_PROVENANCE_INPUT_SCHEMA,
  },
  // v2.2 R2 — universal find-anywhere + discovery surface.
  {
    name: 'sfi.find_field_anywhere',
    description:
      "v2.2 universal-search surface — answers 'where is this field used anywhere in the org?' for one CustomField id, passed as `targetId` or its alias `fieldId` (field-tool-family parity). Walks every incoming non-parentOf edge to the field and groups the referrers by ComponentType: ApexClass / ApexTrigger reads/writes, Flow record-ops, Layout placements, ValidationRule formula refs, SharingRule criteria refs, etc. Each reference carries the referrer's identity, the edge type (`readsFrom` / `writesTo` / `references` / `usedInLayout`), the edge's source extractor, the stored confidence (`declared` for layout/formula edges, `heuristic` for apex-scanner/lwc-scanner edges), and the per-edge properties. Returns `byEdgeType` counts across the FULL set (not the truncated slice). When a ComponentType bucket overflows `limit`, that section is paged via `nextCursor` and the rest are disclosed by count + `otherSections` (echo `nextCursor` back as `cursor` to walk section-by-section). Honesty axis (verbatim): dynamic SOQL strings, reflective field access (`obj.get('FieldName')`), and managed-package code are invisible to the graph edges this tool walks. Invalid prefix → `invalid-query`.",
    inputSchema: FIND_FIELD_ANYWHERE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_semantic_field',
    description:
      "v2.2 semantic-discovery surface — answers 'do we already have a field for X?'. Takes a natural-language `description` and ranks CustomFields by token-overlap (Jaccard) between the query tokens and each field's combined apiName + label + description bag, tokenized per `SemanticSearchSemantics.md` § 'Tokenization rules' (suffix strip, namespace strip, underscore + CamelCase split, lowercase, length filter, stop-word filter). Returns the top `limit` matches above `minScore` (default 0.1); a truncated page returns a `nextCursor` to resume. Each match carries `confidence: 'heuristic'` (Q95 enforcement at the type level), the score, the `matchedTokens` array, and the parent objectId. Optional `objectIds` narrows to fields on a subset of objects. The `boundaries` array surfaces the verbatim Q95 honesty anchor on every call: 'this is a similarity-ranked recommendation … verify the returned field's label and description before treating as the answer.'",
    inputSchema: FIND_SEMANTIC_FIELD_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_hardcoded_values_anywhere',
    description:
      "v2.2 cross-corpus hardcoded-value surface — extends v2.1's `sfi.find_hardcoded_values` (Apex-only) with formula expressions (CustomField.formula), ValidationRule.errorConditionFormula, and WorkflowRule.formula. Supports exact-value mode (`value` specified — `confidence: 'declared'`), shape mode (`category` of `id`/`email`/`date`/`numeric` — `confidence: 'heuristic'`), and combined mode (both). `scope` narrows the searched corpora (default all four). Returns `byCategory` and `bySource` tallies across the FULL set. Honesty axes (verbatim): numeric category has very high false-positive rate (loop counters, indices, constants); ID category is filtered to a key-prefix allowlist; matches in `@isTest`-annotated classes may be intentional test fixtures. Must specify at least one of `value` or `category`. A truncated page returns a `nextCursor` to resume.",
    inputSchema: FIND_HARDCODED_VALUES_ANYWHERE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_clone_patterns',
    description:
      "Structural clone-detection surface. TWO modes. **Seed mode** (`componentId` given) — 'are there other classes / flows like THIS one?': computes the structural fingerprint (set of called Apex / read fields / written fields; triggeredObject for Flow) from outgoing edges and ranks every other same-type component by Jaccard similarity. For Apex: `0.40*callsApexJaccard + 0.30*readsFromJaccard + 0.30*writesToJaccard`. For Flow: `0.40*calledApexJaccard + 0.20*fieldReadJaccard + 0.20*fieldWriteJaccard + 0.20*triggeredObjectMatch`. Returns `matches` above `minScore` (default 0.3) with `similarityBreakdown`. **Cluster mode** (`componentId` OMITTED) — 'where are the copy-pasted classes in this org?': scans every component of `type` (default `ApexClass`; or `ApexTrigger`/`Flow`), scores all pairs, and union-finds those `>= minScore` into `clusters`, each with a stable `clusterId`, its members, and its tightest pair (`topScore`/`topPair`). O(n²), capped at 800 nodes. Every result is `confidence: 'heuristic'`. Honesty axis (verbatim): the fingerprint approximates structural shape, not behavior — two classes with identical fingerprints may behave differently. Cross-type comparison is not supported.",
    inputSchema: FIND_CLONE_PATTERNS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_dead_code',
    description:
      "v2.2 cross-cutting dead-code surface — composes v2.7 `method_reachability` verdict, entry-point taxonomy (REST / Aura / Invocable / Queueable / Batchable / Schedulable / triggers), and zero-usage detection into a single cascade verdict per candidate: `definitely_dead` (zero incoming USAGE edges and not own entry point), `likely_dead` (test-class-only reach), `uncertain` (entry-point reach or own entry point). `parentOf` (structural) and `grantedBy` (Profile / PermissionSet access grants) edges are excluded — access is not usage, so a class nobody calls or a field nothing references is dead even when profiles grant access to it. Default `types` covers ApexClass / ApexTrigger / Flow / CustomField. `includeUncertain` (default false) suppresses the noisy uncertain bucket. Test classes (properties.isTest === true) are NEVER flagged as dead — they ARE entry points for the test-runner. Returns `byVerdict` and `byType` tallies across the FULL set; truncated slice flips `truncated: true` and a truncated page returns a `nextCursor` to resume. Honesty axis (verbatim): dynamic dispatch, reflective invocation, framework wiring (TriggerHandler / fflib), and managed-package callers are invisible to the graph edges this tool walks. Carries a `soundness` envelope: `complete: false` with a `dynamic-apex` blind spot when a candidate class uses dynamic Apex — a class reached only reflectively will read as dead — so a `dead` verdict on a flagged class needs a human check before deletion. When any CALLER family (LWC, Aura, Flows, FlexiPages, Visualforce, …) has incomplete coverage — errored retrieve, scoped refresh, or an in-progress staged build — the response adds a `coverageCaveat` naming the families: an un-retrieved caller would fake death.",
    inputSchema: FIND_DEAD_CODE_INPUT_SCHEMA,
  },
  {
    name: 'sfi.package_impact',
    description:
      "Managed-package boundary surface — 'what does the {namespace} package touch, and what of MINE breaks if I uninstall/upgrade it?'. No InstalledPackage metadata is modelled; package membership is derived from the API-name NAMESPACE PREFIX (a leaf name splitting into >= 3 '__'-segments — `NS__Object__c` — is namespaced; `Object__c` and standard names are not). INVENTORY mode (no `namespace`) scans every node and lists the packages visible in the vault with component counts, most-entangled first — including packages present ONLY via your EXTENSIONS (`extensionCount` > 0 with `componentCount` 0: components you parented under a package's objects), so a package whose own objects are phantoms (e.g. HEDA `hed`, whose managed objects come down as phantom references) is still surfaced as installed instead of reading as 'no packages'. IMPACT mode (`namespace`, e.g. 'SBQQ') returns the package's visible components, `yourDependencies` (incoming non-parentOf edges from components OUTSIDE the namespace — the uninstall blast radius, each carrying fromId/fromType/edgeType/confidence), and `yourExtensions` (your components parented UNDER a package component — custom fields you added to `SBQQ__Quote__c`, orphaned on uninstall). Verdict is `has-dependencies` or the deliberately hedged `no-detected-dependencies` (NEVER 'safe to uninstall'). Honesty axis (verbatim): managed Apex referenced via dot-notation (NS.ClassName) and namespaced components without a standard suffix are invisible; a package's INTERNAL components are usually never retrieved, so packageComponentCount reflects what you can SEE; 'no-detected-dependencies' means no STATIC evidence in retrieved metadata (dynamic SOQL, Type.forName, merge-field references, and unretrieved metadata are invisible) — validate every uninstall in a sandbox first.",
    inputSchema: PACKAGE_IMPACT_INPUT_SCHEMA,
  },
  // v2.6a R2 — CPQ specialist tier. Three tools layered on top of the
  // v1.6 record extractors via the `cpq-extractor` heuristic
  // specialization. All three carry the verbatim recognition-axis
  // disclosure on every emitted response; the `SBQQ__` namespace prefix
  // is the structural recognition signal.
  {
    name: 'sfi.cpq_rule_chain',
    description:
      "v2.6a R2 CPQ-specialist tool: given a CpqProductRule or CpqPriceRule canonical id, returns the chain of rules of the same type sharing the same parent CustomObject (the SBQQ__ rule object definition), sorted by `(active DESC, evaluationOrder ASC, id ASC)`. Each chain entry carries the rule's id, apiName, label, active flag, evaluationOrder, and a 1-indexed `position`. The input rule's position is surfaced separately as `targetPosition`. Honesty axis (verbatim, surfaced ALWAYS): the rule chain reflects the v2.6a-extracted CPQ records only; Apex-customized CPQ rule firing logic (custom `SBQQ.QuoteCalculatorPlugin` implementations) is invisible; runtime re-ordering via the CPQ pricing API is invisible. The chain order shown is the declared evaluation order, not the runtime order. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: CPQ_RULE_CHAIN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cpq_quote_template_breakdown',
    description:
      "v2.6a R2 CPQ-specialist tool: given a CpqQuoteTemplate canonical id, returns the template's top-level configuration (`templateContentReference` from the `SBQQ__Template__c` field, `documentFormat`, `landscape`, `pageBreakBefore`, `active`, `defaultTemplate`) plus a best-effort `sections` list derived from values whose `field` token begins with `SBQQ__Section__c`. Honesty axis (verbatim, surfaced ALWAYS): the full section / field mapping sub-records (`SBQQ__TemplateSection__c`, `SBQQ__TemplateContent__c`) are NOT extracted by v2.6a — the sections surfaced here are a best-effort projection from the template's top-level values mirror; a complete breakdown requires opening the template in the CPQ Quote Template Editor. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: CPQ_QUOTE_TEMPLATE_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.cpq_dependency_map',
    description:
      "v2.6a R2 CPQ-specialist tool: walks the values mirror of every requested CPQ-typed node and surfaces every string-encoded `SBQQ__`-prefixed field reference as a heuristic dependency entry. When `cpqComponentId` is provided, the walker scans only that one component; when omitted, it scans every CPQ-typed node in the vault and pages the resulting dependency list by `limit` (default 50, max 200) — a truncated page returns a `nextCursor` to resume. Each dependency entry carries `fromComponentId`, `fromComponentType`, `fromApiName`, the matched `referencedFieldToken`, and an `occurrenceCount`. Honesty axis (verbatim, surfaced ALWAYS): CPQ dependency mapping is heuristic — string-value scanning catches direct field references but misses formula-walked dependencies, numeric id references, and dynamic-dispatch resolutions. Use this output as a starting point for impact analysis, not as an authoritative dependency graph.",
    inputSchema: CPQ_DEPENDENCY_MAP_INPUT_SCHEMA,
  },
  // v3.0 — unified field forensics synthesis tier (PLAN-v3.0).
  // Two compositional tools over the v0.1-v2.9 extracted graph;
  // surfaces the verbatim Q165 disclosure naming the v1.x extraction
  // gap (`dataNotAvailable: ['list-view-filters', 'reports',
  // 'dashboards']`) on every response. The single accompanying
  // extraction extension (EmailTemplate body merge) ships in the
  // `email-template` extractor; both tools COMPOSE — they do not
  // extract — and the value lies in compositional ergonomics for
  // cross-tier field-forensics questions.
  {
    name: 'sfi.field_360',
    description:
      "v3.0 unified field-forensics synthesis tool. Given a CustomField canonical id (or short `<Object>.<Field>` form), composes every prior tier's reads of the field into one structured response with ten optional content sections (`validates`, `formulas`, `writers`, `readers`, `ui`, `integrations`, `automations`, `emails`, `dependencies`, `summary`) plus the v3.0 constitutional honesty axis. Optional `includeSections` narrows the response; `maxRowsPerSection` (default 50, max 200) bounds per-section row counts; `groupBy` (default `'source'`) reshuffles the rendering hint. The `summary` carries per-section unfiltered counts AND a `riskLevel` (`'low' | 'medium' | 'high'`) computed per PLAN-v3.0 §4.1 with the specific `riskFactors[]` enumerated. The `boundaries[]` array carries the verbatim Q165 disclosure naming which surfaces are composed vs folded elsewhere (list views, reports, dashboards); `dataNotAvailable: ['list-view-filters', 'reports', 'dashboards']` surfaces verbatim regardless of section filter. Top-level `confidence` reports `'mixed'` when sections span tiers (the typical case for any real-org field). Honesty axis (verbatim, ALWAYS): synthesis without omission disclosure is a contract violation; the report is the COMPLETE answer ONLY for extracted axes. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`. When the vault holds captured data-shape facts (`refresh --with-data-shape`), the response embeds a `dataShape` block — the field's sampled fill rate as a stamped `data_snapshot` (sampled + TTL-checked; context, never a live read).",
    inputSchema: FIELD_360_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_lineage',
    description:
      "v3.0 provenance + downstream-effects walker. Given a CustomField canonical id (or short `<Object>.<Field>` form) and a `direction` (`'upstream' | 'downstream' | 'both'`), walks the writers (upstream) or effects (downstream) graph up to `maxDepth` hops (default 3, max 5). Upstream sources carry `sourceKind` (`'workflow-field-update' | 'flow-assignment' | 'apex-write' | 'process-builder-assignment' | 'formula-source' | 'integration-inbound' | 'source-of-truth-field'`), `depth`, `confidence`, and `reachableVia[]` for the per-source path. Downstream effects carry `effectKind` (`'flow-decision-branch' | 'apex-if-clause' | 'workflow-fire' | 'validation-fire' | 'integration-outbound' | 'email-fire' | 'formula-recompute'`), `conditionId` when the effect was sourced from a v2.0a ConditionalContext, and the verbatim `firesWhen` literal when the edge carries one. The upstream payload also carries a `formulaChain { maxDepth, crossesObject }` summary computed from the `formula-source` entries — `maxDepth >= 2` means this field's formula references ANOTHER formula (a multi-hop recompute cascade), and `crossesObject` flags a cross-object formula reference. v2.9 source-of-truth fields are terminal in the upstream walk; v2.7's cycle-detection + depth-bound discipline applies in both directions. `includeFieldsOfTruth` / `includeFiresWhen` default to true. Honesty axis (verbatim, ALWAYS): conditions in `firesWhen` are listed but NOT EVALUATED; the walk is depth-bounded — deeper transitive provenance is NOT walked; lineage inherits the same Q165 `dataNotAvailable[]` disclosure as `sfi.field_360`. Invalid prefix surfaces as `invalid-query`; unknown ids surface as `component-not-found`.",
    inputSchema: FIELD_LINEAGE_INPUT_SCHEMA,
  },
  // v3.1 — cross-org / sandbox-vs-prod comparison tier (4 tools). Reads
  // two registered vaults through `@sf-intelligence/vault`'s registry
  // primitives, then composes per-pair diff over the existing
  // v0.1-v3.0 extraction surface. No new ComponentTypes / EdgeTypes /
  // properties — pure composition tier per PLAN-v3.1 §1.
  {
    name: 'sfi.compare_vaults',
    description:
      "v3.1 cross-org tool: given two registered vault aliases, returns a structured diff identifying `added` (in B only), `removed` (in A only), and `shapeModified` (in both with at least one non-volatile property differing) components. Optional `objectFilter` narrows to one object's parented graph; optional `typeFilter` narrows to one ComponentType family. The volatile-property filter (default ON) suppresses lastModifiedDate / lastModifiedBy / source-tree-hash / manifest-timestamp drift inherited verbatim from v2.0c. `boundaries[]` ALWAYS surfaces (1) the volatile-filter disclosure naming the suppressed property paths and the `includeVolatileProperties: true` opt-out, and (2) the api-name-match correspondence disclosure (renamed components appear as remove+add, NOT as modified). Unknown alias surfaces as the verbatim `vault alias '{alias}' is not registered. Run \\`sfi register-vault {alias} <path>\\` first, or \\`sfi list-vaults\\` to see what's registered.` refusal — the Q170 honesty anchor. Pass `format: 'markdown'` to also get a rendered `markdown` drift dashboard (summary counts + added/removed/shape-modified tables with per-property A→B drift) over the same buckets.",
    inputSchema: COMPARE_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.promotion_readiness',
    description:
      "Promotion readiness: a focused lens on compare_vaults(sandbox → prod). Given two registered vault aliases (`sandbox`, `prod`), returns the SANDBOX-ONLY component set — present in sandbox, absent from prod — i.e. exactly what a deploy must ADD, ranked by how many OTHER sandbox components depend on each one (distinct inbound edges in the sandbox graph) so you deploy the most-depended-on first. Each `promotionItems[]` entry carries `inboundDependencyCount` + a `dependedOnBy` sample; `byType` buckets the set; `summary.sandboxOnlyCount` is the true total (the list is capped at 200). Honesty: the dependency count is a deploy-ORDER priority HINT, not a strict topological order (a dependent may already be in prod or be sandbox-only itself); it is a vault-only structural diff over each vault's last refresh and does NOT deploy or validate against the live org; renamed components read as remove+add; it compares presence, not field/permission shape drift (use compare_vaults shapeModified for that). Unknown alias surfaces the register-vault directive. Optional `typeFilter`.",
    inputSchema: PROMOTION_READINESS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_object_across_vaults',
    description:
      "v3.1 cross-org tool: given a CustomObject api-name and two registered vault aliases, returns the field-by-field diff — `addedFields` (in B only), `removedFields` (in A only), `shapeModifiedFields` (in both with at least one non-volatile property differing) — plus `objectLevelDrift` for CustomObject-level property differences (sharingModel, description, deploymentStatus). `objectExistsInA` / `objectExistsInB` surface false when the named object is missing from a vault. `unchangedFieldCount` / `totalFieldCountA` / `totalFieldCountB` quantify the unfiltered sets so consumers see the baseline. `boundaries[]` ALWAYS carries the volatile-property filter disclosure and the field-api-name-match correspondence disclosure (renamed fields appear as remove+add). Unknown alias surfaces as the Q170 verbatim refusal.",
    inputSchema: COMPARE_OBJECT_ACROSS_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.compare_profile_across_vaults',
    description:
      "v3.1 cross-org tool: given a Profile name and two registered vault aliases, returns per-grant-category drift — `grantDiffs.objectPermissions`, `.fieldPermissions`, `.tabVisibilities`, `.apexClassAccesses`, `.userPermissions`. Each `GrantDiff` carries `targetId`, `side` (`'A' | 'B' | 'both'`), `valueA`, `valueB`. `summary.totalDriftCount` / `perCategoryDriftCount` quantify the drift. `summary.notEvaluatedCategories` lists categories a compared vault did not extract: `tabVisibilities` IS extracted at every refresh and compared normally — but when EITHER vault's refresh predates the P11 extraction (no `properties.tabVisibilities` on the profile), that category is excluded from the counts and disclosed via `notEvaluatedCategories` + a boundary, rather than reported as a fabricated 'no drift' (remedy: re-run `/sfi-refresh` on the stale vault). `boundaries[]` ALWAYS surfaces the profile-edition-rollup disclosure verbatim — when vault A and vault B come from different editions, user-permission set drift may reflect edition differences not configuration drift. v0.1 cannot reliably detect the edition. Unknown alias surfaces as the Q170 verbatim refusal.",
    inputSchema: COMPARE_PROFILE_ACROSS_VAULTS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.field_mapping_between_objects',
    description:
      "v3.1 Q174 honesty-anchor tool: given a single vault alias and TWO CustomObject api-names, returns a heuristic field pairing for migration mapping (the Lead-vs-Contact conversion case). Each `FieldPair` carries `fieldA` / `fieldB` shape (apiName, label, type), the Jaccard `labelSimilarity` over tokenized api-name + label tokens, the `typeCompatible` flag from the static type-compatibility table (text↔text, number↔number, date↔date, picklist↔picklist, reference↔reference), and `confidence: 'heuristic'`. Optional `similarityThreshold` (default 0.50) suppresses pairs below the floor; `includeTypeIncompatible: true` retains label-matched pairs whose types disagree (each flagged `typeMismatch: true`). `unpairedFromA` / `unpairedFromB` list fields without a suggested match. `boundaries[]` ALWAYS surfaces the verbatim Q174 phrase: 'field-mapping suggestions are heuristic — labels are matched by token overlap and types by compatibility table. Verify each suggested pair against your business rules before relying on the mapping for a migration script.' A v3.1 release without this phrase is a contract violation regardless of test-suite green (PLAN-v3.1 §10 constitutional axis).",
    inputSchema: FIELD_MAPPING_BETWEEN_OBJECTS_INPUT_SCHEMA,
  },
  // v3.2 — OmniStudio composition tier. The
  // `sfi.datatransform_field_map` tool composes the v3.2-R2c
  // OmniDataTransform extractor (journal 0167) into a readable
  // source-to-target field-mapping table; the per-row
  // `declared`/`parsed` confidence is the load-bearing honesty axis,
  // and the Native-vs-Vlocity disclosure surfaces verbatim in
  // `boundaries[]` on every response.
  {
    name: 'sfi.datatransform_field_map',
    description:
      "v3.2 OmniStudio tool: given an OmniDataTransform canonical id (`OmniDataTransform:{Name}_{VersionNumber}`), returns the DataRaptor's source-to-target field mapping plus the operation-type metadata (Extract / Load / Transform). Composes the v3.2-R2c extractor's node (top-level `<sourceObject>`, `<inputType>`, `<interfaceClass>` with `<type>` fallback, `<active>` flag, `<description>`) with a fresh re-parse of the source XML for the per-row `<omniDataTransformItem>` table. Each `mappings[]` row carries `name`, `sourceField` (verbatim `<inputFieldName>`), `targetField` (verbatim `<outputFieldName>`), `outputObjectName`, `upsertKey`, `requiredForUpsert`, `disabled`, and a per-row `confidence` — `declared` when both field paths arrive as direct XML elements with no colon-prefix alias, `parsed` when either path uses the designer-controlled `{ObjectAlias}:{fieldPath}` convention (the v3.2-R2c extractor's edge-level confidence split). `sourceObject` and `targetObject` surface the top-level source SObject and the best-effort target SObject (first non-`json` `outputObjectName`); `operationType` pins the raw `<type>` element verbatim. `inputSampleJson` / `outputSampleJson` carry the designer's `<expectedInputJson>` / `<expectedOutputJson>` payloads when present. `boundaries[]` ALWAYS surfaces (1) the Native-vs-Vlocity disclosure and (2) the per-row confidence disclosure explaining the `declared`/`parsed` axis. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: DATATRANSFORM_FIELD_MAP_INPUT_SCHEMA,
  },
  // v3.2 — OmniStudio declarative-process tier. The
  // `sfi.decision_table_browse` tool is the Q179 row-data honesty
  // anchor of the v3.2 wave; row content is NEVER enumerated and
  // the verbatim refusal phrase surfaces in `boundaries[]` on every
  // response.
  {
    name: 'sfi.decision_table_browse',
    description:
      "v3.2 OmniStudio tool: given a DecisionTable canonical id (`DecisionTable:{SetupName}`), returns the table's parameter shape — `dataSourceType` (`CsvUpload` | `SObject` | `Manual`), `executionType` (`HBASE` | `OnPrem`), `inputParams[]` (each `{ name, type, defaultValue }` ordered by `<sequence>`) and `outputParams[]` (each `{ name, type }`) — and ALWAYS sets `rows: null`. v3.2 will NOT enumerate row content; row data lives in the CSV uploaded to Salesforce Files, in the `sourceObject` SObject records, or in the OmniStudio designer's row-editor UI. The Q179 honesty anchor: `boundaries[]` ALWAYS carries the verbatim phrase 'DecisionTable rows live in CSV uploads or SObject records, not in the metadata XML. v3.2 cannot enumerate row content. To see the actual rows, query the row data source (SObject record query or the original CSV).' followed by a dataSourceType-specific row-store hint, then the Native-vs-Vlocity disclosure for discipline consistency. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: DECISION_TABLE_BROWSE_INPUT_SCHEMA,
  },
  // v3.2 R3b — the "walk this IP's action chain" Q177 surface.
  // Composes the v3.2-R2 OmniIntegrationProcedure node metadata with
  // a fresh re-parse of the source XML (for per-action shape and the
  // terminal Response Action's `additionalOutput`) and a per-step
  // endpoint classification (REST / DataRaptor / nested IP / Remote
  // Action). REST URLs and Apex `class.method` targets are surfaced
  // verbatim with `parsed` confidence — v3.2 does NOT probe URLs and
  // does NOT emit Apex-edge resolution (v3.3 follow-up). Four
  // verbatim boundary disclosures surface ALWAYS — Native-vs-Vlocity,
  // v3.3 Apex-coupling deferral, OmniProcessElement record-level,
  // and the REST-endpoint reachability caveat.
  {
    name: 'sfi.integration_procedure_chain',
    description:
      "v3.2 R3b OmniStudio composer tool: given an OmniIntegrationProcedure canonical id, returns the IP's identity metadata (`omniProcessKey`, `versionNumber`, `subType`, `type`, `uniqueName`, `isActive`), the ordered action chain (one row per `<omniProcessElements>` child, sorted by sequenceNumber ASC, each carrying `name`, `type`, `description`, `sequenceNumber`, `isActive`, and the optional `executionConditionalFormula`), the `externalEndpoints[]` per-step breakdown (kind `'rest' | 'dataraptor' | 'remote-action' | 'integration-procedure'`; REST steps surface the verbatim `restPath` and `namedCredential`, DataRaptor / nested-IP steps surface the resolved `targetId` when the target is in the vault and `null` for dangling references, Remote Action steps surface `class.method` verbatim — no Apex-edge resolution per v3.3 deferral), and the parsed `responseShape` from the terminal Response Action's `additionalOutput`. Optional `includeChildPropertySetConfig: true` attaches each action's parsed `propertySetConfig` JSON blob (1-10kB per action). REST URLs are surfaced with `parsed` confidence — v3.2 does NOT probe the URL or verify the Named Credential against live state. `boundaries[]` ALWAYS surfaces FOUR verbatim disclosures: (1) the Native-vs-Vlocity-Legacy axis (Q180 anchor), (2) the v3.3 Apex-coupling deferral, (3) the OmniProcessElement record-level boundary (Q179 anchor), and (4) the REST-endpoint reachability caveat. Non-IP prefixes surface as `invalid-query`; unknown well-formed ids surface as `component-not-found`; missing source files surface as `component-not-found` with the verbatim source path.",
    inputSchema: INTEGRATION_PROCEDURE_CHAIN_INPUT_SCHEMA,
  },
  // v3.2 R3a — the "walk this OmniScript end-to-end" Q176 surface.
  // Composes the v3.2-R2 OmniScript node properties with a fresh re-
  // parse of the source XML (for per-step shape) and the outgoing
  // `dispatchesOmniAction` edge family (for the IP / DataRaptor / OS
  // dispatch targets). Three verbatim boundary disclosures surface
  // ALWAYS — Native-vs-Vlocity, OmniProcessElement record-level,
  // and the v3.3 Apex-coupling deferral.
  {
    name: 'sfi.omniscript_flow',
    description:
      "v3.2 OmniStudio tool: given an OmniScript canonical id (`OmniScript:{ApiName}`), returns the parsed step sequence (the `<omniProcessElements>` children walked recursively, sorted by `level` ASC then `sequenceNumber` ASC), the downstream IP / DataRaptor / sibling-OmniScript dispatches resolved through `dispatchesOmniAction` outgoing edges (each entry carries `stepName`, `stepType`, `targetId` — null when dangling — `targetRawName`, and edge `confidence`), and the OmniScript's identity metadata (`omniProcessType`, `versionNumber`, `language`, `subType`, `type`, `uniqueName`, `isActive`, `isWebCompEnabled`) sourced from the v3.2 R2 extractor's node properties. Optional `includeChildPropertySetConfig: true` attaches each step's parsed `propertySetConfig` JSON blob to its entry (off by default — blobs can be kilobytes per step). The Q176 / Q179 / Q180 honesty anchors surface ALWAYS in `boundaries[]`: (1) Native-vs-Vlocity-Legacy detection is heuristic; (2) OmniProcessElement record-level data is out of scope; (3) Apex-to-OmniProcess coupling (`implements omnistudio.VlocityOpenInterface`) is a v3.3 follow-up — not yet in the graph. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: OMNISCRIPT_FLOW_INPUT_SCHEMA,
  },
  // v3.2 R3d — the "what's inside this FlexCard" surface. Composes
  // the v3.2 R2 OmniUiCard extractor's node properties (identity,
  // dataSourceType, dataSourceContextVariables) with a fresh
  // re-parse of the source XML's `<propertySetConfig>` JSON blob
  // (for the recursive widget tree) and the outgoing
  // `dispatchesOmniAction` edge family (for Action-widget OmniScript
  // / IP dispatches). Two verbatim boundary disclosures surface
  // ALWAYS — the propertySetConfig-parsing caveat (widget order
  // follows the JSON, not the visual designer's drag-drop order)
  // AND Native-vs-Vlocity-Legacy.
  {
    name: 'sfi.omniuicard_widget_breakdown',
    description:
      "v3.2 OmniStudio tool: given an OmniUiCard canonical id (`OmniUiCard:{ApiName}`), returns the FlexCard's identity metadata (`omniUiCardType`, `authorName`, `versionNumber`, `isActive`, `isManagedUsingStdDesigner` — sourced from the v3.2 R2 extractor's node properties), the parsed `states[]` array each carrying `name`, `stateIndex`, recursive `widgetCount`, and the full recursive `widgets[]` tree (each widget carries `name`, `element`, `elementLabel`, `type`, and nested `children[]` for Block / Datatable Row containers), the declared `dataSource` (`type` + `contextVariables[]`), and the `dispatchedActions[]` list resolved through outgoing `dispatchesOmniAction` edges (each entry: `stateName`, `stateIndex`, `widgetLabel`, `actionListIndex`, `actionType` ('OmniScript' | 'Integration Procedure'), `targetId`, `targetRawName`, edge `confidence`). The widget tree is re-parsed from the source XML on demand because the propertySetConfig blob is large (tens of KB per real-org card) and the v3.2 R2 extractor stores only aggregate counts on the node. `boundaries[]` ALWAYS surfaces (1) the propertySetConfig-parsing disclosure verbatim explaining widget order follows the JSON's declared order, not the visual designer's drag-drop order, AND (2) the Native-vs-Vlocity-Legacy disclosure. Invalid prefix surfaces as `invalid-query`; unknown id surfaces as `component-not-found`.",
    inputSchema: OMNIUICARD_WIDGET_BREAKDOWN_INPUT_SCHEMA,
  },
  {
    name: 'sfi.find_component_usages',
    description:
      "The universal \"where is this component used?\" answer for ANY canonical component type (`componentId`) — one entry point instead of fanning out across find_field_anywhere / find_code_usages / get_impact / grep. Composes two evidence tiers: (1) GRAPH — incoming dependency edges to the target, grouped by referrer type, each carrying edge `confidence`, EXCLUDING access grants (`grantedBy`) and structural `parentOf` (access is not usage); (2) GREP supplement (`text-match` tier, `includeGrep` default true) — a literal search of Apex AND frontend bundle source (LWC/Aura/Visualforce — `$Label`/`$Resource`/`@salesforce` module references) for the api name, catching references the graph does not model (dynamic SOQL, reflective access, CustomMetadataType / CustomLabel / StaticResource refs). `graphReferrers[]` (type + count + sample), `grepSupplement` (matches with path/line/snippet), `summary` (counts + `hasStaticEvidence`), `boundaries[]`, `truncated`. HONESTY: empty graph + empty grep = \"no static evidence in the vault\" (in `boundaries`), NEVER \"nothing uses this\" — dynamic constructs, un-modeled families (reports/dashboards/list-views), and managed packages are invisible. Phantom-aware (a referenced-but-not-retrieved target still answers from its edges). Specialized tools (find_field_anywhere, layout_assignments, …) stay for a deeper single-family answer; this unifies the common case. Non-canonical id → `invalid-query`; an id with no node AND no referrers → `component-not-found`.",
    inputSchema: FIND_COMPONENT_USAGES_INPUT_SCHEMA,
  },
  {
    name: 'sfi.installed_package_catalog',
    description:
      "Answer \"what packages are installed in this org?\" from the `InstalledPackage` metadata the refresh extracts (`installedPackages/<namespace>.installedPackage-meta.xml`). Each `packages[]` row is a managed/unlocked package: `namespace` (the prefix its components carry — `hed__Course__c` -> `hed`) and the installed `versionNumber` (e.g. `8.293`, or `null` when not declared). `summary.count` is the total; the list is COMPLETE (orgs have tens of packages, not thousands) and sorted by namespace. `declared` confidence. This is the package INVENTORY with real version + namespace data — not inferred from component prefixes — and grounds the managed-extension taxonomy; for what a namespace's components TOUCH use `package_impact`. `boundaryNote`: an empty list is disclosed as 'not modeled' (no InstalledPackage metadata / pre-extraction refresh), not a verified 'no packages'; component namespace prefixes still indicate ownership without this catalog.",
    inputSchema: INSTALLED_PACKAGE_CATALOG_INPUT_SCHEMA,
  },
  {
    name: 'sfi.annotations',
    description:
      'Read the curated annotations overlay (`meta/annotations.jsonl`): ownership, lifecycle status (e.g. deprecated), glossary synonyms, domain grouping, and notes that humans stated — or AI proposed and a human confirmed — about org components. Provenance `annotation` (curated, NOT derived from the org snapshot); unconfirmed `source: ai` entries are PROPOSALS, not facts. Optional `componentId` / `key` narrow the read. Annotations survive refreshes; orphans (annotated ids no longer in the graph) surface in the refresh pulse and `sfi annotate orphans`.',
    inputSchema: ANNOTATIONS_INPUT_SCHEMA,
  },
  {
    name: 'sfi.propose_annotation',
    description:
      "Record an AI-PROPOSED annotation (owner / status / glossary / domain / note) for a component. Written ALWAYS as `source: 'ai', confirmed: false` — the server cannot confirm; a human confirms with `sfi annotate <id> --key <k> --value <v> --confirm`. Session rate-cap (20) prevents flooding. Local vault-file write only (meta/annotations.jsonl) — never touches Salesforce. Propose when the user TELLS you meaning worth keeping ('this field is deprecated', 'RevOps owns this') so the knowledge outlives the session as a reviewable proposal.",
    inputSchema: PROPOSE_ANNOTATION_INPUT_SCHEMA,
  },
  {
    name: 'sfi.component_history',
    description:
      "The component's change timeline from the vault's OWN git history (`sfi vault git enable`): `git log --follow` over its source file — one entry per source-changing refresh — merged with the org-declared metadata lastModified stamps; optional capped unified diff of the most recent change (`includeLatestDiff`). A vault without history answers `available: false` with the enable hint, never an error. Local repo only; refresh-granularity, not the org audit trail.",
    inputSchema: COMPONENT_HISTORY_INPUT_SCHEMA,
  },
  {
    name: 'sfi.component_as_of',
    description:
      "The component AS IT WAS at a git ref in the vault's own history: `git show <ref>:<sourcePath>` re-run through the SAME extractor the refresh uses for that type → declared properties-as-of (apiName/label/type + extractor properties). Types without a wired as-of extractor return capped raw historical content with `extracted: false`. A vault without history answers `available: false` + the enable hint; an unknown ref fails structured with a coverage note. Local repo only.",
    inputSchema: COMPONENT_AS_OF_INPUT_SCHEMA,
  },
];

/**
 * The set of `V01_TOOLS` names indexed for O(1) membership checks in
 * `dispatchTool`. Built once at module load.
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  V01_TOOLS.map((tool) => tool.name),
);

/**
 * Route a `tools/call` request to its per-tool handler. v0.1 implements
 * one handler at a time; the dispatcher matches by `toolName`, runs the
 * tool's Zod parse against `args`, calls the handler, and serializes the
 * `McpResponse` or `McpError` envelope through `jsonResult`. Any tool
 * still without an implementation falls through to the not-implemented
 * branch and unknown names hit `unknown-tool`.
 *
 * @example
 *   const result = await dispatchTool(ctx, 'sfi.search_components', { query: 'Industry' });
 *   // => { content: [{ type: 'text', text: '{"data":{"matches":[...]}, ...}' }] }
 */
export const dispatchTool = async (
  ctx: Context,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> => {
  if (!KNOWN_TOOL_NAMES.has(toolName)) {
    return jsonResult({
      error: 'unknown-tool',
      message: `no tool registered with name '${toolName}'`,
      toolName,
    });
  }

  // Governance: append-only audit of the call (no-op unless
  // SF_INTELLIGENCE_AUDIT_LOG is set). Arg keys only — never values.
  auditToolCall({
    ts: new Date().toISOString(),
    tool: toolName,
    argKeys: Object.keys(args),
    vaultHash: ctx.manifest.sourceTreeHash,
  });

  switch (toolName) {
    case 'sfi.search_components':
      return runTool(
        ctx,
        args,
        searchComponentsInputSchema,
        searchComponentsHandler,
      );
    case 'sfi.resolve':
      return runTool(ctx, args, resolveInputSchema, resolveHandler);
    case 'sfi.capabilities':
      return runTool(ctx, args, capabilitiesInputSchema, capabilitiesHandler);
    case 'sfi.list_analyses':
      return runTool(ctx, args, listAnalysesInputSchema, listAnalysesHandler);
    case 'sfi.describe_analysis':
      return runTool(
        ctx,
        args,
        describeAnalysisInputSchema,
        describeAnalysisHandler,
      );
    case 'sfi.run_analysis': {
      // BYTE-IDENTITY CONTRACT (P13-GW-meta-tools): the gateway returns the
      // target tool's envelope VERBATIM — no runTool re-wrap, so payload,
      // byte budget, and trust block are exactly a direct call's.
      const parsed = runAnalysisInputSchema.safeParse(args);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return jsonResult({ error: { kind: 'invalid-query', message } });
      }
      const resolved = resolveRunAnalysis(parsed.data);
      if (!resolved.ok) return jsonResult({ error: resolved.error });
      if (!KNOWN_TOOL_NAMES.has(resolved.value.name)) {
        return jsonResult({
          error: {
            kind: 'invalid-query',
            message: `Unknown analysis '${parsed.data.name}'. Call sfi.list_analyses for the catalog.`,
          },
        });
      }
      return dispatchTool(ctx, resolved.value.name, resolved.value.args);
    }
    case 'sfi.guidance':
      return runTool(ctx, args, guidanceInputSchema, guidanceHandler);
    case 'sfi.synthesize_answer':
      return runTool(
        ctx,
        args,
        synthesizeAnswerInputSchema,
        synthesizeAnswerHandler,
      );
    case 'sfi.org_pulse':
      return runTool(ctx, args, orgPulseInputSchema, orgPulseHandler);
    case 'sfi.org_card':
      return runTool(ctx, args, orgCardInputSchema, orgCardHandler);
    case 'sfi.fleet_find':
      return runTool(ctx, args, fleetFindInputSchema, fleetFindHandler);
    case 'sfi.fleet_drift_ranking':
      return runTool(
        ctx,
        args,
        fleetDriftRankingInputSchema,
        fleetDriftRankingHandler,
      );
    case 'sfi.get_component':
      return runTool(
        ctx,
        args,
        getComponentInputSchema,
        getComponentHandler,
      );
    case 'sfi.list_components':
      return runTool(
        ctx,
        args,
        listComponentsInputSchema,
        listComponentsHandler,
      );
    case 'sfi.get_edges':
      return runTool(ctx, args, getEdgesInputSchema, getEdgesHandler);
    case 'sfi.get_subgraph':
      return runTool(ctx, args, getSubgraphInputSchema, getSubgraphHandler);
    case 'sfi.search_apex_source':
      return runTool(
        ctx,
        args,
        searchApexSourceInputSchema,
        searchApexSourceHandler,
      );
    case 'sfi.search_flow_metadata':
      return runTool(
        ctx,
        args,
        searchFlowMetadataInputSchema,
        searchFlowMetadataHandler,
      );
    case 'sfi.get_naming_convention_report':
      return runTool(
        ctx,
        args,
        namingConventionReportInputSchema,
        namingConventionReportHandler,
      );
    case 'sfi.get_manifest':
      return runTool(ctx, args, getManifestInputSchema, getManifestHandler);
    case 'sfi.coverage_report':
      return runTool(ctx, args, coverageReportInputSchema, coverageReportHandler);
    case 'sfi.retrieve_blindspot_report':
      return runTool(
        ctx,
        args,
        retrieveBlindspotReportInputSchema,
        retrieveBlindspotReportHandler,
      );
    case 'sfi.health_check':
      return runTool(ctx, args, healthCheckInputSchema, healthCheckHandler);
    case 'sfi.baseline_acknowledge':
      return runTool(
        ctx,
        args,
        baselineAcknowledgeInputSchema,
        baselineAcknowledgeHandler,
      );
    case 'sfi.baseline_status':
      return runTool(ctx, args, baselineStatusInputSchema, baselineStatusHandler);
    case 'sfi.live_describe':
      return runTool(ctx, args, liveDescribeInputSchema, liveDescribeHandler);
    case 'sfi.live_count':
      return runTool(ctx, args, liveCountInputSchema, liveCountHandler);
    case 'sfi.live_stale_check':
      return runTool(ctx, args, liveStaleCheckInputSchema, liveStaleCheckHandler);
    case 'sfi.live_sample':
      return runTool(ctx, args, liveSampleInputSchema, liveSampleHandler);
    case 'sfi.live_field_population':
      return runTool(
        ctx,
        args,
        liveFieldPopulationInputSchema,
        liveFieldPopulationHandler,
      );
    case 'sfi.live_group_count':
      return runTool(ctx, args, liveGroupCountInputSchema, liveGroupCountHandler);
    case 'sfi.live_stale_records':
      return runTool(ctx, args, liveStaleRecordsInputSchema, liveStaleRecordsHandler);
    case 'sfi.live_recent_activity':
      return runTool(ctx, args, liveRecentActivityInputSchema, liveRecentActivityHandler);
    case 'sfi.live_aggregate':
      return runTool(ctx, args, liveAggregateInputSchema, liveAggregateHandler);
    case 'sfi.live_duplicate_check':
      return runTool(ctx, args, liveDuplicateCheckInputSchema, liveDuplicateCheckHandler);
    case 'sfi.live_owner_breakdown':
      return runTool(ctx, args, liveOwnerBreakdownInputSchema, liveOwnerBreakdownHandler);
    case 'sfi.live_storage_by_object':
      return runTool(ctx, args, liveStorageByObjectInputSchema, liveStorageByObjectHandler);
    case 'sfi.live_org_limits':
      return runTool(ctx, args, liveOrgLimitsInputSchema, liveOrgLimitsHandler);
    case 'sfi.live_inactive_users':
      return runTool(
        ctx,
        args,
        liveInactiveUsersInputSchema,
        liveInactiveUsersHandler,
      );
    case 'sfi.live_license_usage':
      return runTool(
        ctx,
        args,
        liveLicenseUsageInputSchema,
        liveLicenseUsageHandler,
      );
    case 'sfi.live_consent':
      return runTool(ctx, args, liveConsentInputSchema, liveConsentHandler);
    case 'sfi.live_report_usage':
      return runTool(ctx, args, liveReportUsageInputSchema, liveReportUsageHandler);
    case 'sfi.live_folder_access':
      return runTool(ctx, args, liveFolderAccessInputSchema, liveFolderAccessHandler);
    case 'sfi.live_email_template_usage':
      return runTool(
        ctx,
        args,
        liveEmailTemplateUsageInputSchema,
        liveEmailTemplateUsageHandler,
      );
    case 'sfi.live_org_health':
      return runTool(ctx, args, liveOrgHealthInputSchema, liveOrgHealthHandler);
    case 'sfi.live_automation_fired':
      return runTool(ctx, args, liveAutomationFiredInputSchema, liveAutomationFiredHandler);
    case 'sfi.live_picklist_usage':
      return runTool(ctx, args, livePicklistUsageInputSchema, livePicklistUsageHandler);
    case 'sfi.live_budget':
      return runTool(ctx, args, liveBudgetInputSchema, liveBudgetHandler);
    case 'sfi.route_question':
      return runTool(ctx, args, routeQuestionInputSchema, routeQuestionHandler);
    case 'sfi.org_risk_report':
      return runTool(ctx, args, orgRiskReportInputSchema, orgRiskReportHandler);
    case 'sfi.field_cleanup_candidates':
      return runTool(
        ctx,
        args,
        fieldCleanupCandidatesInputSchema,
        fieldCleanupCandidatesHandler,
      );
    case 'sfi.automation_risk_report':
      return runTool(
        ctx,
        args,
        automationRiskReportInputSchema,
        automationRiskReportHandler,
      );
    case 'sfi.permission_risk_report':
      return runTool(
        ctx,
        args,
        permissionRiskReportInputSchema,
        permissionRiskReportHandler,
      );
    case 'sfi.release_readiness_report':
      return runTool(
        ctx,
        args,
        releaseReadinessReportInputSchema,
        releaseReadinessReportHandler,
      );
    case 'sfi.get_impact':
      return runTool(ctx, args, getImpactInputSchema, getImpactHandler);
    case 'sfi.blast_radius_live':
      return runTool(ctx, args, blastRadiusLiveInputSchema, blastRadiusLiveHandler);
    case 'sfi.find_formula_references':
      return runTool(
        ctx,
        args,
        findFormulaReferencesInputSchema,
        findFormulaReferencesHandler,
      );
    case 'sfi.find_apex_usages':
      return runTool(
        ctx,
        args,
        findApexUsagesInputSchema,
        findApexUsagesHandler,
      );
    case 'sfi.effective_permissions':
      return runTool(
        ctx,
        args,
        effectivePermissionsInputSchema,
        effectivePermissionsHandler,
      );
    case 'sfi.who_can_run':
      return runTool(ctx, args, whoCanRunInputSchema, whoCanRunHandler);
    case 'sfi.who_can_access_object':
      return runTool(
        ctx,
        args,
        whoCanAccessObjectInputSchema,
        whoCanAccessObjectHandler,
      );
    case 'sfi.why_cant_user_see_record':
      return runTool(
        ctx,
        args,
        whyCantUserSeeRecordInputSchema,
        whyCantUserSeeRecordHandler,
      );
    case 'sfi.layout_for_user':
      return runTool(
        ctx,
        args,
        layoutForUserInputSchema,
        layoutForUserHandler,
      );
    case 'sfi.user_ability':
      return runTool(ctx, args, userAbilityInputSchema, userAbilityHandler);
    case 'sfi.lightning_pages':
      return runTool(ctx, args, lightningPagesInputSchema, lightningPagesHandler);
    case 'sfi.list_view_sharing':
      return runTool(ctx, args, listViewSharingInputSchema, listViewSharingHandler);
    case 'sfi.app_access':
      return runTool(ctx, args, appAccessInputSchema, appAccessHandler);
    case 'sfi.tab_availability':
      return runTool(ctx, args, tabAvailabilityInputSchema, tabAvailabilityHandler);
    case 'sfi.lifecycle_process':
      return runTool(
        ctx,
        args,
        lifecycleProcessInputSchema,
        lifecycleProcessHandler,
      );
    case 'sfi.layout_assignments':
      return runTool(
        ctx,
        args,
        layoutAssignmentsInputSchema,
        layoutAssignmentsHandler,
      );
    case 'sfi.integration_map':
      return runTool(
        ctx,
        args,
        integrationMapInputSchema,
        integrationMapHandler,
      );
    case 'sfi.event_subscribers':
      return runTool(
        ctx,
        args,
        eventSubscribersInputSchema,
        eventSubscribersHandler,
      );
    case 'sfi.find_code_usages':
      return runTool(
        ctx,
        args,
        findCodeUsagesInputSchema,
        findCodeUsagesHandler,
      );
    case 'sfi.lookup_record':
      return runTool(
        ctx,
        args,
        lookupRecordInputSchema,
        lookupRecordHandler,
      );
    case 'sfi.explain_field':
      return runTool(
        ctx,
        args,
        explainFieldInputSchema,
        explainFieldHandler,
      );
    case 'sfi.safe_to_delete_field':
      return runTool(
        ctx,
        args,
        safeToDeleteFieldInputSchema,
        safeToDeleteFieldHandler,
      );
    case 'sfi.unused_components':
      return runTool(
        ctx,
        args,
        unusedComponentsInputSchema,
        unusedComponentsHandler,
      );
    case 'sfi.find_dependency_cycles':
      return runTool(
        ctx,
        args,
        findDependencyCyclesInputSchema,
        findDependencyCyclesHandler,
      );
    case 'sfi.apex_test_coverage':
      return runTool(
        ctx,
        args,
        apexTestCoverageInputSchema,
        apexTestCoverageHandler,
      );
    case 'sfi.automation_build_advisor':
      return runTool(
        ctx,
        args,
        automationBuildAdvisorInputSchema,
        automationBuildAdvisorHandler,
      );
    case 'sfi.apex_build_advisor':
      return runTool(
        ctx,
        args,
        apexBuildAdvisorInputSchema,
        apexBuildAdvisorHandler,
      );
    case 'sfi.field_change_advisor':
      return runTool(
        ctx,
        args,
        fieldChangeAdvisorInputSchema,
        fieldChangeAdvisorHandler,
      );
    case 'sfi.live_drift_check':
      return runTool(
        ctx,
        args,
        liveDriftCheckInputSchema,
        liveDriftCheckHandler,
      );
    case 'sfi.org_history':
      return runTool(ctx, args, orgHistoryInputSchema, orgHistoryHandler);
    case 'sfi.what_changed_since_refresh':
      return runTool(
        ctx,
        args,
        whatChangedSinceRefreshInputSchema,
        whatChangedSinceRefreshHandler,
      );
    case 'sfi.diff_snapshots':
      return runTool(
        ctx,
        args,
        diffSnapshotsInputSchema,
        diffSnapshotsHandler,
      );
    case 'sfi.churn':
      return runTool(ctx, args, churnInputSchema, churnHandler);
    case 'sfi.trend':
      return runTool(ctx, args, trendInputSchema, trendHandler);
    case 'sfi.compare_components':
      return runTool(
        ctx,
        args,
        compareComponentsInputSchema,
        compareComponentsHandler,
      );
    case 'sfi.export_manifest':
      return runTool(
        ctx,
        args,
        exportManifestInputSchema,
        exportManifestHandler,
      );
    case 'sfi.pii_inventory':
      return runTool(
        ctx,
        args,
        piiInventoryInputSchema,
        piiInventoryHandler,
      );
    case 'sfi.field_access_audit':
      return runTool(
        ctx,
        args,
        fieldAccessAuditInputSchema,
        fieldAccessAuditHandler,
      );
    case 'sfi.object_access_audit':
      return runTool(
        ctx,
        args,
        objectAccessAuditInputSchema,
        objectAccessAuditHandler,
      );
    case 'sfi.recordtype_availability':
      return runTool(
        ctx,
        args,
        recordtypeAvailabilityInputSchema,
        recordtypeAvailabilityHandler,
      );
    case 'sfi.org_overview':
      return runTool(
        ctx,
        args,
        orgOverviewInputSchema,
        orgOverviewHandler,
      );
    case 'sfi.domain_clusters':
      return runTool(
        ctx,
        args,
        domainClustersInputSchema,
        domainClustersHandler,
      );
    case 'sfi.changed_since':
      return runTool(
        ctx,
        args,
        changedSinceInputSchema,
        changedSinceHandler,
      );
    case 'sfi.last_modified':
      return runTool(
        ctx,
        args,
        lastModifiedInputSchema,
        lastModifiedHandler,
      );
    case 'sfi.what_happens_on_save':
      return runTool(
        ctx,
        args,
        whatHappensOnSaveInputSchema,
        whatHappensOnSaveHandler,
      );
    case 'sfi.why_field_changed':
      return runTool(
        ctx,
        args,
        whyFieldChangedInputSchema,
        whyFieldChangedHandler,
      );
    case 'sfi.order_of_execution':
      return runTool(
        ctx,
        args,
        orderOfExecutionInputSchema,
        orderOfExecutionHandler,
      );
    case 'sfi.explain_flow':
      return runTool(
        ctx,
        args,
        explainFlowInputSchema,
        explainFlowHandler,
      );
    case 'sfi.explain_apex_method':
      return runTool(
        ctx,
        args,
        explainApexMethodInputSchema,
        explainApexMethodHandler,
      );
    case 'sfi.explain_formula':
      return runTool(
        ctx,
        args,
        explainFormulaInputSchema,
        explainFormulaHandler,
      );
    case 'sfi.unused_fields_deep':
      return runTool(
        ctx,
        args,
        unusedFieldsDeepInputSchema,
        unusedFieldsDeepHandler,
      );
    case 'sfi.process_builder_migration_candidates':
      return runTool(
        ctx,
        args,
        processBuilderMigrationCandidatesInputSchema,
        processBuilderMigrationCandidatesHandler,
      );
    case 'sfi.unassigned_permission_sets':
      return runTool(
        ctx,
        args,
        unassignedPermissionSetsInputSchema,
        unassignedPermissionSetsHandler,
      );
    case 'sfi.installed_package_catalog':
      return runTool(
        ctx,
        args,
        installedPackageCatalogInputSchema,
        installedPackageCatalogHandler,
      );
    case 'sfi.annotations':
      return runTool(ctx, args, annotationsInputSchema, annotationsHandler);
    case 'sfi.propose_annotation':
      return runTool(
        ctx,
        args,
        proposeAnnotationInputSchema,
        proposeAnnotationHandler,
      );
    case 'sfi.component_history':
      return runTool(ctx, args, componentHistoryInputSchema, componentHistoryHandler);
    case 'sfi.component_as_of':
      return runTool(ctx, args, componentAsOfInputSchema, componentAsOfHandler);
    case 'sfi.find_component_usages':
      return runTool(
        ctx,
        args,
        findComponentUsagesInputSchema,
        findComponentUsagesHandler,
      );
    case 'sfi.empty_queues_and_groups':
      return runTool(
        ctx,
        args,
        emptyQueuesAndGroupsInputSchema,
        emptyQueuesAndGroupsHandler,
      );
    case 'sfi.tech_debt_score':
      return runTool(
        ctx,
        args,
        techDebtScoreInputSchema,
        techDebtScoreHandler,
      );
    case 'sfi.code_quality_audit':
      return runTool(
        ctx,
        args,
        codeQualityAuditInputSchema,
        codeQualityAuditHandler,
      );
    case 'sfi.governor_limit_risks':
      return runTool(
        ctx,
        args,
        governorLimitRisksInputSchema,
        governorLimitRisksHandler,
      );
    case 'sfi.find_hardcoded_values':
      return runTool(
        ctx,
        args,
        findHardcodedValuesInputSchema,
        findHardcodedValuesHandler,
      );
    case 'sfi.crud_fls_audit':
      return runTool(
        ctx,
        args,
        crudFlsAuditInputSchema,
        crudFlsAuditHandler,
      );
    case 'sfi.test_coverage_gaps':
      return runTool(
        ctx,
        args,
        testCoverageGapsInputSchema,
        testCoverageGapsHandler,
      );
    case 'sfi.what_if_change_field_type':
      return runTool(
        ctx,
        args,
        whatIfChangeFieldTypeInputSchema,
        whatIfChangeFieldTypeHandler,
      );
    case 'sfi.what_if_change_field_value':
      return runTool(
        ctx,
        args,
        whatIfChangeFieldValueInputSchema,
        whatIfChangeFieldValueHandler,
      );
    case 'sfi.value_change_audit':
      return runTool(
        ctx,
        args,
        valueChangeAuditInputSchema,
        valueChangeAuditHandler,
      );
    case 'sfi.what_if_remove_picklist_value':
      return runTool(
        ctx,
        args,
        whatIfRemovePicklistValueInputSchema,
        whatIfRemovePicklistValueHandler,
      );
    case 'sfi.what_if_make_field_required':
      return runTool(
        ctx,
        args,
        whatIfMakeFieldRequiredInputSchema,
        whatIfMakeFieldRequiredHandler,
      );
    case 'sfi.what_if_deactivate_flow':
      return runTool(
        ctx,
        args,
        whatIfDeactivateFlowInputSchema,
        whatIfDeactivateFlowHandler,
      );
    case 'sfi.what_if_disable_trigger':
      return runTool(
        ctx,
        args,
        whatIfDisableTriggerInputSchema,
        whatIfDisableTriggerHandler,
      );
    case 'sfi.what_if_change_method_signature':
      return runTool(
        ctx,
        args,
        whatIfChangeMethodSignatureInputSchema,
        whatIfChangeMethodSignatureHandler,
      );
    case 'sfi.what_if_merge_profiles':
      return runTool(
        ctx,
        args,
        whatIfMergeProfilesInputSchema,
        whatIfMergeProfilesHandler,
      );
    case 'sfi.what_if_split_profile':
      return runTool(
        ctx,
        args,
        whatIfSplitProfileInputSchema,
        whatIfSplitProfileHandler,
      );
    case 'sfi.generate_data_dictionary':
      return runTool(
        ctx,
        args,
        generateDataDictionaryInputSchema,
        generateDataDictionaryHandler,
      );
    case 'sfi.generate_admin_handbook':
      return runTool(
        ctx,
        args,
        generateAdminHandbookInputSchema,
        generateAdminHandbookHandler,
      );
    case 'sfi.generate_architecture_overview':
      return runTool(
        ctx,
        args,
        generateArchitectureOverviewInputSchema,
        generateArchitectureOverviewHandler,
      );
    case 'sfi.generate_sharing_summary':
      return runTool(
        ctx,
        args,
        generateSharingSummaryInputSchema,
        generateSharingSummaryHandler,
      );
    case 'sfi.generate_compliance_report':
      return runTool(
        ctx,
        args,
        generateComplianceReportInputSchema,
        generateComplianceReportHandler,
      );
    case 'sfi.generate_onboarding_doc':
      return runTool(
        ctx,
        args,
        generateOnboardingDocInputSchema,
        generateOnboardingDocHandler,
      );
    // v2.7 R2 — deep code understanding tier (class granularity).
    case 'sfi.call_graph':
      return runTool(ctx, args, callGraphInputSchema, callGraphHandler);
    case 'sfi.downstream_effects':
      return runTool(
        ctx,
        args,
        downstreamEffectsInputSchema,
        downstreamEffectsHandler,
      );
    case 'sfi.test_coverage_for_method':
      return runTool(
        ctx,
        args,
        testCoverageForMethodInputSchema,
        testCoverageForMethodHandler,
      );
    case 'sfi.meaningful_test_audit':
      return runTool(
        ctx,
        args,
        meaningfulTestAuditInputSchema,
        meaningfulTestAuditHandler,
      );
    case 'sfi.method_reachability':
      return runTool(
        ctx,
        args,
        methodReachabilityInputSchema,
        methodReachabilityHandler,
      );
    case 'sfi.tests_for_change':
      return runTool(
        ctx,
        args,
        testsForChangeInputSchema,
        testsForChangeHandler,
      );
    case 'sfi.cdc_subscribers':
      return runTool(
        ctx,
        args,
        cdcSubscribersInputSchema,
        cdcSubscribersHandler,
      );
    case 'sfi.async_chain_depth':
      return runTool(
        ctx,
        args,
        asyncChainDepthInputSchema,
        asyncChainDepthHandler,
      );
    case 'sfi.scheduled_job_catalog':
      return runTool(
        ctx,
        args,
        scheduledJobCatalogInputSchema,
        scheduledJobCatalogHandler,
      );
    case 'sfi.outbound_message_catalog':
      return runTool(
        ctx,
        args,
        outboundMessageCatalogInputSchema,
        outboundMessageCatalogHandler,
      );
    case 'sfi.endpoint_catalog':
      return runTool(
        ctx,
        args,
        endpointCatalogInputSchema,
        endpointCatalogHandler,
      );
    // v2.9 R4 — vocabulary + semantic-disambiguation tier.
    case 'sfi.field_meaning':
      return runTool(
        ctx,
        args,
        fieldMeaningInputSchema,
        fieldMeaningHandler,
      );
    case 'sfi.disambiguate_concepts':
      return runTool(
        ctx,
        args,
        disambiguateConceptsInputSchema,
        disambiguateConceptsHandler,
      );
    case 'sfi.field_provenance':
      return runTool(
        ctx,
        args,
        fieldProvenanceInputSchema,
        fieldProvenanceHandler,
      );
    // v2.2 R2 — universal find-anywhere + discovery surface.
    case 'sfi.find_field_anywhere':
      return runTool(
        ctx,
        args,
        findFieldAnywhereInputSchema,
        findFieldAnywhereHandler,
      );
    case 'sfi.find_semantic_field':
      return runTool(
        ctx,
        args,
        findSemanticFieldInputSchema,
        findSemanticFieldHandler,
      );
    case 'sfi.find_hardcoded_values_anywhere':
      return runTool(
        ctx,
        args,
        findHardcodedValuesAnywhereInputSchema,
        findHardcodedValuesAnywhereHandler,
      );
    case 'sfi.find_clone_patterns':
      return runTool(
        ctx,
        args,
        findClonePatternsInputSchema,
        findClonePatternsHandler,
      );
    case 'sfi.find_dead_code':
      return runTool(
        ctx,
        args,
        findDeadCodeInputSchema,
        findDeadCodeHandler,
      );
    case 'sfi.package_impact':
      return runTool(
        ctx,
        args,
        packageImpactInputSchema,
        packageImpactHandler,
      );
    // v2.6a R2 — CPQ specialist tier.
    case 'sfi.cpq_rule_chain':
      return runTool(
        ctx,
        args,
        cpqRuleChainInputSchema,
        cpqRuleChainHandler,
      );
    case 'sfi.cpq_quote_template_breakdown':
      return runTool(
        ctx,
        args,
        cpqQuoteTemplateBreakdownInputSchema,
        cpqQuoteTemplateBreakdownHandler,
      );
    case 'sfi.cpq_dependency_map':
      return runTool(
        ctx,
        args,
        cpqDependencyMapInputSchema,
        cpqDependencyMapHandler,
      );
    // v3.0 — unified field forensics synthesis tier.
    case 'sfi.field_360':
      return runTool(ctx, args, field360InputSchema, field360Handler);
    case 'sfi.field_lineage':
      return runTool(
        ctx,
        args,
        fieldLineageInputSchema,
        fieldLineageHandler,
      );
    // v3.1 — cross-org / sandbox-vs-prod comparison tier.
    case 'sfi.promotion_readiness':
      return runTool(
        ctx,
        args,
        promotionReadinessInputSchema,
        promotionReadinessHandler,
      );
    case 'sfi.compare_vaults':
      return runTool(
        ctx,
        args,
        compareVaultsInputSchema,
        compareVaultsHandler,
      );
    case 'sfi.compare_object_across_vaults':
      return runTool(
        ctx,
        args,
        compareObjectAcrossVaultsInputSchema,
        compareObjectAcrossVaultsHandler,
      );
    case 'sfi.compare_profile_across_vaults':
      return runTool(
        ctx,
        args,
        compareProfileAcrossVaultsInputSchema,
        compareProfileAcrossVaultsHandler,
      );
    case 'sfi.field_mapping_between_objects':
      return runTool(
        ctx,
        args,
        fieldMappingBetweenObjectsInputSchema,
        fieldMappingBetweenObjectsHandler,
      );
    // v3.2 — OmniStudio composition tier (DataRaptor field-mapping table).
    case 'sfi.datatransform_field_map':
      return runTool(
        ctx,
        args,
        datatransformFieldMapInputSchema,
        datatransformFieldMapHandler,
      );
    // v3.2 — OmniStudio declarative-process tier (DecisionTable browse).
    case 'sfi.decision_table_browse':
      return runTool(
        ctx,
        args,
        decisionTableBrowseInputSchema,
        decisionTableBrowseHandler,
      );
    // v3.2 R3b — OmniStudio "walk this IP's action chain" Q177 surface.
    case 'sfi.integration_procedure_chain':
      return runTool(
        ctx,
        args,
        integrationProcedureChainInputSchema,
        integrationProcedureChainHandler,
      );
    // v3.2 R3a — OmniStudio "walk this OmniScript end-to-end" surface.
    case 'sfi.omniscript_flow':
      return runTool(
        ctx,
        args,
        omniscriptFlowInputSchema,
        omniscriptFlowHandler,
      );
    // v3.2 R3d — OmniStudio "what's inside this FlexCard" surface.
    case 'sfi.omniuicard_widget_breakdown':
      return runTool(
        ctx,
        args,
        omniuicardWidgetBreakdownInputSchema,
        omniuicardWidgetBreakdownHandler,
      );
    default:
      // Defensive: every name in `V01_TOOLS` should be handled above. If
      // a future tool is added without a `case`, the not-implemented
      // envelope keeps the dispatch loop alive instead of crashing.
      return jsonResult({
        error: 'not-implemented',
        message: `tool '${toolName}' awaits its mcp-tool-* task implementation`,
        toolName,
      });
  }
};

/**
 * Generic per-tool dispatch helper. Each `dispatchTool` case calls this
 * with its Zod schema and handler; `runTool` Zod-parses the args (emits
 * an `invalid-query` envelope on failure), then invokes the handler and
 * wraps the success or `McpError` it returns in the SDK's response
 * envelope. Centralising this kept the 10 `mcp-tool-*` tasks each a
 * single one-liner `case` rather than re-implementing the parse +
 * dispatch + serialize loop.
 *
 * It ALSO catches an UNEXPECTED throw from the handler (or from the
 * serialize step inside `jsonResult` — e.g. a `JSON.stringify` TypeError on
 * a BigInt/circular value) and returns a sized `internal`-kind error
 * envelope routed through the SAME `jsonResult` byte budget, so an
 * exception that would otherwise escape to the SDK as a raw, unsized
 * JSON-RPC error (bypassing the structured-envelope + size-guard contract
 * and potentially leaking org content or a stack trace in the message) is
 * instead bounded and safe. The client-facing message is a fixed generic
 * literal — never the throw's message — and the full error is logged to
 * stderr only. A handler that RETURNS a structural `McpError` still flows
 * the normal path and keeps its own kind (the catch fires only on a thrown
 * exception, so a returned `err()` is never re-wrapped as `internal`).
 *
 * `runTool` is exported only so the response-size/leak unit tests can drive
 * it directly with a synthetic throwing handler.
 */
export const runTool = async <S extends z.ZodTypeAny, T>(
  ctx: Context,
  args: Readonly<Record<string, unknown>>,
  schema: S,
  handler: (
    ctx: Context,
    input: z.infer<S>,
  ) => Promise<Result<McpResponse<T>, McpError>>,
): Promise<CallToolResult> => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    // Format the Zod issues into a concise human-readable string rather
    // than returning `parsed.error.message` — which is the pretty-printed
    // full `issues` JSON array (a ~2.4 KB blob). `McpError` carries no
    // structured `details` field, so we surface only the human message.
    const message = parsed.error.issues
      .map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('; ');
    return jsonResult({
      error: { kind: 'invalid-query', message },
    });
  }
  try {
    const result = await handler(ctx, parsed.data);
    return jsonResult(result.ok ? result.value : { error: result.error }, {
      args: parsed.data as unknown as Readonly<Record<string, unknown>>,
      knobs: narrowingKnobs(schema),
      vaultRoot: ctx.vaultRoot,
    });
  } catch (error) {
    // An unexpected throw escaped the handler (or the serialize step). Log
    // the FULL error (incl. stack, which may carry org content) to stderr
    // for server-side debugging ONLY, then return a sized `internal`
    // envelope whose client-facing message is a fixed literal — never the
    // throw's message — so no raw stack or org value reaches the client.
    // Routing through `jsonResult` keeps even this error under the byte
    // budget. Do NOT interpolate `error`, `parsed.data`, `args`, or `ctx`.
    console.error('sf-intelligence: runTool internal error in handler:', error);
    return jsonResult(
      {
        error: {
          kind: 'internal',
          message:
            'An internal error occurred while handling this tool. The server logged the details.',
        },
      },
      { knobs: narrowingKnobs(schema) },
    );
  }
};

/**
 * Register the v0.1 tool list and call handlers on `server`. Idempotent
 * within a single `Server` instance; not safe to call across instances
 * (the SDK throws if a handler is registered twice).
 *
 * @example
 *   const server = new Server({ name: 'sf-intelligence', version: '0.1.0' });
 *   registerTools(server, ctx);
 */
// P13-GW profile primitives live in tool-profile.ts (cycle-free for
// route-question's gateway envelopes); re-exported here as the public API.
export { CORE_PROFILE_TOOLS, toolProfile } from './tool-profile.js';

/** The roster a server with the given profile ADVERTISES on tools/list. */
export const advertisedTools = (
  profile: 'core' | 'full' = resolveToolProfile(),
): typeof V01_TOOLS =>
  profile === 'core'
    ? V01_TOOLS.filter((t) => CORE_TOOLS_SET.has(t.name))
    : V01_TOOLS;

export const registerTools = (server: Server, ctx: Context): void => {
  // P13-WATCH-epoch: the served context follows the vault's refresh epoch —
  // a refresh while this server is open swaps in a fresh graph connection on
  // the NEXT call (no restart). Held mutably here; tools never see the swap.
  let currentCtx = ctx;
  // Profile is FIXED here, at boot (see toolProfile). Under `core`, only the
  // 18 core schemas are advertised — dispatch below stays un-narrowed, so a
  // direct call to a non-advertised tool (or via run_analysis) still works:
  // the profile reduces schema tokens, never capability.
  const roster = advertisedTools();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: roster.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as {
        readonly type: 'object';
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Readonly<
      Record<string, unknown>
    >;
    currentCtx = await maybeReopenOnEpochChange(currentCtx);
    // The only real `tools/call` seam — instrument HERE (not in dispatchTool,
    // which recurses for run_analysis and is shared with CLI-internal calls,
    // nor in runTool, which misses the unknown-tool early-return). Returns the
    // CallToolResult unchanged; emits one metric only when SFI_METRICS_LOG set.
    const name = request.params.name;
    return instrumentDispatch(name, () => dispatchTool(currentCtx, name, args));
  });
};

/**
 * HARD ceiling on every serialized response envelope. An MCP client rejects a
 * tool result above its token limit OUTRIGHT (~55 KB observed live): the
 * whole response is dropped and the caller gets an opaque harness error
 * instead of a usable answer or a clear message. This global guard (in
 * `jsonResult`) trips well below that observed limit and, crucially, ABOVE
 * the per-tool 28 KB graph budget (`GRAPH_MAX_PAYLOAD_BYTES`) so the
 * already-bounded `get_impact` / `get_subgraph` slices never collide with
 * it. Tools without their own byte budget — e.g. `what_if_merge_profiles`,
 * `what_if_split_profile`, `compare_vaults` — rely on this backstop.
 */
export const MAX_RESPONSE_BYTES = 45_000;

/**
 * Default for the GLOBAL escalating response budget (P13-GUARD-global-size).
 * Sits BELOW `MAX_RESPONSE_BYTES` so the budget's truncate/slim passes rescue
 * a payload before it ever reaches the hard ceiling, and well under the ~55 KB
 * observed client rejection including envelope overhead. Override with
 * `SFI_MAX_RESPONSE_BYTES` (floor 2 000 — below that the error envelope itself
 * wouldn't fit).
 */
export const RESPONSE_BUDGET_DEFAULT_BYTES = 40_000;

/** Resolve the active response budget from `SFI_MAX_RESPONSE_BYTES`. */
export const responseBudgetBytes = (): number => {
  const raw = process.env['SFI_MAX_RESPONSE_BYTES'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 2_000
    ? Math.min(Math.floor(parsed), MAX_RESPONSE_BYTES)
    : RESPONSE_BUDGET_DEFAULT_BYTES;
};

/** Narrowing context `runTool` threads through so the guard can speak the tool's own language. */
interface ResponseNarrowing {
  /** The tool's parsed input args (offset-shaped pagination detection). */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Input-schema knobs that narrow a query (limit/offset/hops/filter/…). */
  readonly knobs?: readonly string[];
  /** Vault root for the org-drift badge lookup (P13-WATCH-badges). */
  readonly vaultRoot?: string;
}

/** Pass 2 trims strings longer than this… */
const SLIM_STRING_THRESHOLD_BYTES = 1_536;
/** …down to this many leading characters plus a marker. */
const SLIM_STRING_KEEP_CHARS = 1_024;
/** Pass 1 never truncates an array below this many elements. */
const TRUNCATE_KEEP_MIN = 10;

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Pass 1 — truncate the largest top-level arrays under `data` from the tail
 * until the body fits (or nothing further can be dropped). Returns the total
 * dropped element count and the kept length of the largest-trimmed array
 * (for `nextOffset` when the call was offset-shaped).
 */
const truncateDataArrays = (
  body: Record<string, unknown>,
  cap: number,
): { dropped: number; keptOfLargest: number | null } => {
  const data = body['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { dropped: 0, keptOfLargest: null };
  }
  const record = data as Record<string, unknown>;
  const arrays = Object.keys(record)
    .filter(
      (k) =>
        Array.isArray(record[k]) &&
        (record[k] as readonly unknown[]).length > TRUNCATE_KEEP_MIN,
    )
    .sort((a, b) => utf8Bytes(record[b]) - utf8Bytes(record[a]));
  let dropped = 0;
  let keptOfLargest: number | null = null;
  for (const key of arrays) {
    let list = record[key] as unknown[];
    while (list.length > TRUNCATE_KEEP_MIN && utf8Bytes(body) > cap) {
      const keep = Math.max(TRUNCATE_KEEP_MIN, Math.floor(list.length / 2));
      dropped += list.length - keep;
      list = list.slice(0, keep);
      record[key] = list;
    }
    if (keptOfLargest === null && dropped > 0) keptOfLargest = list.length;
    if (utf8Bytes(body) <= cap) break;
  }
  return { dropped, keptOfLargest };
};

/** Pass 2 — slim every long string under a node to a head + trim marker. */
const slimDataStrings = (node: unknown): number => {
  const slim = (v: string): string =>
    `${v.slice(0, SLIM_STRING_KEEP_CHARS)} …[+${
      Buffer.byteLength(v, 'utf8') - SLIM_STRING_KEEP_CHARS
    } bytes trimmed]`;
  if (Array.isArray(node)) {
    let count = 0;
    const list = node as unknown[];
    for (let i = 0; i < list.length; i += 1) {
      const v = list[i];
      if (
        typeof v === 'string' &&
        Buffer.byteLength(v, 'utf8') > SLIM_STRING_THRESHOLD_BYTES
      ) {
        list[i] = slim(v);
        count += 1;
      } else {
        count += slimDataStrings(v);
      }
    }
    return count;
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    let count = 0;
    for (const k of Object.keys(record)) {
      const v = record[k];
      if (
        typeof v === 'string' &&
        Buffer.byteLength(v, 'utf8') > SLIM_STRING_THRESHOLD_BYTES
      ) {
        record[k] = slim(v);
        count += 1;
      } else {
        count += slimDataStrings(v);
      }
    }
    return count;
  }
  return 0;
};

/**
 * Build the SDK's expected response envelope: a single text block whose
 * body is canonical JSON. Centralized so the not-implemented and
 * unknown-tool branches share a shape.
 *
 * GLOBAL response budget (P13-GUARD-global-size — absorbs P12-B25-hardening +
 * P12-lazy-graph). Every body gains a top-level `estimatedPayloadBytes`. A
 * envelope over the budget is rescued by escalating passes — never
 * handed to the client as an opaque rejection:
 *
 *   1. truncate the largest top-level `data` arrays from the tail
 *      (`responseBudget.truncated/droppedCount`, plus `nextOffset` when the
 *      call was offset-shaped);
 *   2. slim long strings to a head + `…[+N bytes trimmed]` marker;
 *   3. if it STILL does not fit, a structured `oversize` error naming the
 *      tool's own narrowing knobs (from its input schema).
 *
 * Under-budget object payloads pass through byte-identical apart from the
 * added `estimatedPayloadBytes` field. Oversized error envelopes preserve
 * their error shape when string trimming is sufficient; otherwise they become
 * a compact structured `oversize` error. Per-tool budgets (e.g. the 28 KB
 * graph slices) stay primary; this is the backstop that retires the
 * oversize-rejection bug class for EVERY tool at once.
 */
export const jsonResult = (
  bodyInput: unknown,
  narrowing?: ResponseNarrowing,
): CallToolResult => {
  const cap = responseBudgetBytes();
  const result = (text: string): CallToolResult => ({
    content: [{ type: 'text' as const, text }],
  });
  const fits = (text: string): boolean =>
    Buffer.byteLength(text, 'utf8') <= cap;
  const oversizeResult = (
    estimatedPayloadBytes: number,
    originalErrorKind?: string,
  ): CallToolResult => {
    const boundedErrorKind = originalErrorKind?.slice(0, 64);
    const knobs = (narrowing?.knobs ?? [])
      .slice(0, 8)
      .map((knob) => knob.slice(0, 64));
    const error: McpError = {
      kind: 'oversize',
      message:
        `${boundedErrorKind === undefined ? "This tool's response" : `The '${boundedErrorKind}' error response`} ` +
        `(~${Math.round(estimatedPayloadBytes / 1000)} KB) exceeds the response budget ` +
        `(~${Math.round(cap / 1000)} KB, SFI_MAX_RESPONSE_BYTES). Re-query with a narrower scope${
          knobs.length > 0
            ? ` — this tool supports: ${knobs.join(', ')}`
            : ' (filter, pagination, fewer hops)'
        }.`,
    };
    return result(JSON.stringify({ error, estimatedPayloadBytes }));
  };

  let body = bodyInput;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    const text = JSON.stringify(body) ?? 'null';
    return fits(text)
      ? result(text)
      : oversizeResult(Buffer.byteLength(text, 'utf8'));
  }
  const isErrorEnvelope =
    'error' in body && (body as { readonly error?: unknown }).error != null;

  // P13-WATCH-badges: when a FRESH stale-sweep shows org drift whose types
  // intersect this answer, attach the orgDrift badge (silent otherwise; a
  // vault without staleness.json is byte-identical to pre-badge behavior).
  // Attached BEFORE the byte budget so the cap still holds with the badge.
  if (!isErrorEnvelope && narrowing?.vaultRoot !== undefined && 'data' in body) {
    const badge = orgDriftBadgeFor(
      narrowing.vaultRoot,
      JSON.stringify((body as { readonly data?: unknown }).data ?? null),
    );
    if (badge !== null) {
      body = { ...(body as Record<string, unknown>), orgDrift: badge };
    }
  }

  const baseBytes = utf8Bytes(body);
  const serialize = (value: Record<string, unknown>): string =>
    JSON.stringify({ ...value, estimatedPayloadBytes: baseBytes });
  const original = serialize(body as Record<string, unknown>);

  if (fits(original)) {
    return result(original);
  }

  // Over budget: escalate on a clone — the handler's object is never mutated.
  const clone = structuredClone(body) as Record<string, unknown>;
  if (isErrorEnvelope) {
    slimDataStrings(clone);
    const trimmedError = serialize(clone);
    if (fits(trimmedError)) return result(trimmedError);

    const rawError = clone['error'];
    const originalErrorKind =
      typeof rawError === 'string'
        ? rawError
        : rawError !== null && typeof rawError === 'object'
          ? String(
              (rawError as { readonly kind?: unknown }).kind ?? 'unknown-error',
            )
          : 'unknown-error';
    return oversizeResult(baseBytes, originalErrorKind);
  }

  // Reserve room for the responseBudget and estimatedPayloadBytes fields so
  // the check applies to the final serialized envelope, not only its body.
  const reductionCap = Math.max(1, cap - Math.min(1_024, Math.floor(cap / 4)));
  const { dropped, keptOfLargest } = truncateDataArrays(clone, reductionCap);
  let stringsSlimmed = 0;
  if (utf8Bytes(clone) > reductionCap) {
    stringsSlimmed = slimDataStrings(clone);
  }
  if (utf8Bytes(clone) <= reductionCap) {
    const args = narrowing?.args ?? {};
    const offset = args['offset'];
    const offsetShaped = 'offset' in args || typeof offset === 'number';
    // CR-22 seam: a cursor-aware handler attaches its own `pageInfo`/`nextCursor`
    // to `data`. When present, the handler's pagination is authoritative — do
    // NOT overwrite it with this guard's approximate `nextOffset` (which the
    // handler already accounted for). For UNCONVERTED offset tools the guard
    // keeps the approximate `nextOffset` but adds an honest note that the
    // dropped tail can't be resumed exactly.
    const handlerPaginated = hasHandlerCursor(
      (clone as { readonly data?: unknown }).data,
    );
    const emitApproxNextOffset =
      dropped > 0 && offsetShaped && keptOfLargest !== null && !handlerPaginated;
    clone['responseBudget'] = {
      applied: true,
      ...(dropped > 0 ? { truncated: true, droppedCount: dropped } : {}),
      ...(emitApproxNextOffset
        ? {
            nextOffset:
              (typeof offset === 'number' ? offset : 0) + keptOfLargest,
          }
        : {}),
      ...(stringsSlimmed > 0 ? { stringsSlimmed } : {}),
      note: handlerPaginated
        ? 'Response exceeded the byte budget and long strings were trimmed; use this tool’s own nextCursor to page (the handler’s pagination is authoritative).'
        : emitApproxNextOffset
          ? 'Response exceeded the byte budget and was reduced to fit (lists tail-truncated, long strings trimmed). The nextOffset is approximate — re-query from it for the dropped tail.'
          : 'Response exceeded the byte budget and was reduced to fit (lists tail-truncated, long strings trimmed); the dropped tail cannot be resumed from this response — narrow the query or page with limit/offset for complete rows.',
    };
    const reduced = serialize(clone);
    if (fits(reduced)) return result(reduced);
  }

  // Pass 3 — even reduced it cannot fit: structured oversize error with the
  // tool's own narrowing knobs instead of an opaque client rejection.
  return oversizeResult(baseBytes);
};

/** Input-schema keys that narrow a query — surfaced in oversize guidance. */
const NARROWING_KNOB_RE =
  /^(limit|offset|cursor|hops|maxDepth|maxBodyBytes|maxRowsPerSection|grepLimit|format|verbosity|scope|type|types|category|classification|direction)$|filter/i;

/** Extract narrowing knob names from a tool's Zod input schema (object schemas only). */
const narrowingKnobs = (schema: z.ZodTypeAny): readonly string[] => {
  // Duck-typed: ZodObject exposes `.shape`; `z` is a type-only import here.
  const shape = (schema as { readonly shape?: unknown }).shape;
  return shape !== null && typeof shape === 'object'
    ? Object.keys(shape as Record<string, unknown>).filter((k) =>
        NARROWING_KNOB_RE.test(k),
      )
    : [];
};
