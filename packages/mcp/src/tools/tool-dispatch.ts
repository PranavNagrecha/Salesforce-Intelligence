/**
 * Tool dispatch — handler imports and dispatchTool / runTool / jsonResult.
 *
 * Contains all per-handler imports, the dispatchTool switch, runTool,
 * and the jsonResult serialization layer. Split from tools/index.ts (R7-F2)
 * to remove the merge hotspot on that file.
 *
 * @see roster.ts  — V01_TOOLS definition array + types
 * @see index.ts   — thin re-exports + registerTools
 */

import { homedir } from 'node:os';

import {
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ORG_METADATA_CONTENT_POLICY,
  type McpError,
  type McpResponse,
} from '@sf-intelligence/contracts';
import type { Result } from '@sf-intelligence/core';
import type { z } from 'zod';

import { auditToolCall } from '../audit.js';
import {
  mintLiveCapability,
} from '../live-capability.js';
import type { Context } from '../server.js';

import {
  actionChainHandler,
  actionChainInputSchema,
} from './action-chain.js';
import {
  aiExposureReportHandler,
  aiExposureReportInputSchema,
} from './ai-exposure-report.js';
import {
  annotationsHandler,
  annotationsInputSchema,
  confirmAnnotationHandler,
  confirmAnnotationInputSchema,
  proposeAnnotationHandler,
  proposeAnnotationInputSchema,
  rejectAnnotationHandler,
  rejectAnnotationInputSchema,
  reviewAnnotationsHandler,
  reviewAnnotationsInputSchema,
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
  automationCollisionsHandler,
  automationCollisionsInputSchema,
} from './automation-collisions.js';
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
  componentChangeAttributionHandler,
  componentChangeAttributionInputSchema,
} from './component-change-attribution.js';
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
  docCoverageReportHandler,
  docCoverageReportInputSchema,
} from './doc-coverage-report.js';
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
  explainDebugLogHandler,
  explainDebugLogInputSchema,
} from './explain-debug-log.js';
import {
  explainErrorHandler,
  explainErrorInputSchema,
} from './explain-error.js';
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
  generateFleetReportHandler,
  generateFleetReportInputSchema,
} from './fleet-report.js';
import {
  flowBulkificationAuditHandler,
  flowBulkificationAuditInputSchema,
} from './flow-bulkification-audit.js';
import {
  flowFaultAuditHandler,
  flowFaultAuditInputSchema,
} from './flow-fault-audit.js';
import {
  flowGraphHandler,
  flowGraphInputSchema,
} from './flow-graph.js';
import {
  flowTraceHandler,
  flowTraceInputSchema,
} from './flow-trace.js';
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
import {
  guestExposureReportHandler,
  guestExposureReportInputSchema,
} from './guest-exposure-report.js';
import { guidanceHandler, guidanceInputSchema } from './guidance.js';
import {
  healthCheckHandler,
  healthCheckInputSchema,
} from './health-check.js';
import {
  historyTrackingGapsHandler,
  historyTrackingGapsInputSchema,
} from './history-tracking-gaps.js';
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
import { interpretHandler, interpretInputSchema } from './interpret.js';
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
  limitHeadroomReportHandler,
  limitHeadroomReportInputSchema,
} from './limit-headroom-report.js';
import {
  listComponentsHandler,
  listComponentsInputSchema,
} from './list-components.js';
import {
  listViewSharingHandler,
  listViewSharingInputSchema,
} from './list-view-sharing.js';
import {
  liveAccessOracleHandler,
  liveAccessOracleInputSchema,
} from './live-access-oracle.js';
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
  liveFieldHistoryHandler,
  liveFieldHistoryInputSchema,
  liveOwnerBreakdownHandler,
  liveOwnerBreakdownInputSchema,
  liveRecordAccessHandler,
  liveRecordAccessInputSchema,
  liveRecordSharesHandler,
  liveRecordSharesInputSchema,
  liveScheduledJobsHandler,
  liveScheduledJobsInputSchema,
  liveStorageByObjectHandler,
  liveStorageByObjectInputSchema,
  liveStaleRecordsHandler,
  liveStaleRecordsInputSchema,
  livePermsetHoldersHandler,
  livePermsetHoldersInputSchema,
  liveGroupMembersHandler,
  liveGroupMembersInputSchema,
  liveUserPermsetsHandler,
  liveUserPermsetsInputSchema,
  liveSetupAuditTrailHandler,
  liveSetupAuditTrailInputSchema,
  liveZombieAccountsHandler,
  liveZombieAccountsInputSchema,
  liveDataSkewHandler,
  liveDataSkewInputSchema,
  liveSecurityExposureHandler,
  liveSecurityExposureInputSchema,
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
  nonselectiveSoqlHandler,
  nonselectiveSoqlInputSchema,
} from './nonselective-soql.js';
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
  permissionSetConsolidationHandler,
  permissionSetConsolidationInputSchema,
} from './permission-set-consolidation.js';
import {
  picklistIntegrityScanHandler,
  picklistIntegrityScanInputSchema,
} from './picklist-integrity-scan.js';
import {
  piiInventoryHandler,
  piiInventoryInputSchema,
} from './pii-inventory.js';
import {
  processBuilderMigrationCandidatesHandler,
  processBuilderMigrationCandidatesInputSchema,
} from './process-builder-migration-candidates.js';
import {
  profileSecurityHandler,
  profileSecurityInputSchema,
} from './profile-security.js';
import {
  promotionReadinessHandler,
  promotionReadinessInputSchema,
} from './promotion-readiness.js';
import {
  queryGraphHandler,
  queryGraphInputSchema,
} from './query-graph.js';
import {
  recordCreationPathsHandler,
  recordCreationPathsInputSchema,
} from './record-creation-paths.js';
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
  reviewChangeHandler,
  reviewChangeInputSchema,
} from './review-change.js';
import {
  KNOWN_TOOL_NAMES,
  TOOL_BY_NAME,
} from './roster.js';
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
import { reconcileSoePhasesOmittedAfterGlobalTrim } from './soe-payload-bounds.js';
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
import {
  traceDebugLogHandler,
  traceDebugLogInputSchema,
} from './trace-debug-log.js';
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
  whatIfAssignPermsetHandler,
  whatIfAssignPermsetInputSchema,
  whatIfRevokePermsetHandler,
  whatIfRevokePermsetInputSchema,
} from './what-if-permset.js';
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


export const dispatchTool = async (
  ctxIn: Context,
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

  const def = TOOL_BY_NAME.get(toolName);
  if (def === undefined) {
    return jsonResult({
      error: 'unknown-tool',
      message: `no tool registered with name '${toolName}'`,
      toolName,
    });
  }

  // Bind the registry livePlane capability for this invoke. Overwrites any
  // caller-supplied liveCapability so a never tool can never inherit a
  // parent/test capability by accident; run_analysis re-entry rebinds for
  // the *target* tool. Under exactOptionalPropertyTypes, omit the field
  // entirely when the tag is `never` (do not assign `undefined`).
  // AUDIT-F3: also bind liveToolName so scope step-up can resolve per tool.
  const { liveCapability: _ignored, liveToolName: _ignoredTool, ...ctxBase } =
    ctxIn;
  const capability = mintLiveCapability(def.livePlane);
  const withTool: Context = { ...ctxBase, liveToolName: toolName };
  const ctx: Context =
    capability === undefined
      ? withTool
      : { ...withTool, liveCapability: capability };

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
      const resolved = resolveRunAnalysis(parsed.data, KNOWN_TOOL_NAMES);
      if (!resolved.ok) return jsonResult({ error: resolved.error });
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
    case 'sfi.generate_fleet_report':
      return runTool(
        ctx,
        args,
        generateFleetReportInputSchema,
        generateFleetReportHandler,
      );
    case 'sfi.get_component':
      return runTool(
        ctx,
        args,
        getComponentInputSchema,
        getComponentHandler,
      );
    case 'sfi.limit_headroom_report':
      return runTool(
        ctx,
        args,
        limitHeadroomReportInputSchema,
        limitHeadroomReportHandler,
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
    case 'sfi.query_graph':
      return runTool(ctx, args, queryGraphInputSchema, queryGraphHandler);
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
    case 'sfi.live_record_access':
      return runTool(ctx, args, liveRecordAccessInputSchema, liveRecordAccessHandler);
    case 'sfi.live_access_oracle':
      return runTool(ctx, args, liveAccessOracleInputSchema, liveAccessOracleHandler);
    case 'sfi.live_record_shares':
      return runTool(ctx, args, liveRecordSharesInputSchema, liveRecordSharesHandler);
    case 'sfi.live_scheduled_jobs':
      return runTool(ctx, args, liveScheduledJobsInputSchema, liveScheduledJobsHandler);
    case 'sfi.live_field_history':
      return runTool(ctx, args, liveFieldHistoryInputSchema, liveFieldHistoryHandler);
    case 'sfi.live_storage_by_object':
      return runTool(ctx, args, liveStorageByObjectInputSchema, liveStorageByObjectHandler);
    case 'sfi.live_org_limits':
      return runTool(ctx, args, liveOrgLimitsInputSchema, liveOrgLimitsHandler);
    case 'sfi.live_data_skew':
      return runTool(ctx, args, liveDataSkewInputSchema, liveDataSkewHandler);
    case 'sfi.live_security_exposure':
      return runTool(
        ctx,
        args,
        liveSecurityExposureInputSchema,
        liveSecurityExposureHandler,
      );
    case 'sfi.live_inactive_users':
      return runTool(
        ctx,
        args,
        liveInactiveUsersInputSchema,
        liveInactiveUsersHandler,
      );
    case 'sfi.live_permset_holders':
      return runTool(
        ctx,
        args,
        livePermsetHoldersInputSchema,
        livePermsetHoldersHandler,
      );
    case 'sfi.live_zombie_accounts':
      return runTool(
        ctx,
        args,
        liveZombieAccountsInputSchema,
        liveZombieAccountsHandler,
      );
    case 'sfi.live_group_members':
      return runTool(
        ctx,
        args,
        liveGroupMembersInputSchema,
        liveGroupMembersHandler,
      );
    case 'sfi.live_user_permsets':
      return runTool(
        ctx,
        args,
        liveUserPermsetsInputSchema,
        liveUserPermsetsHandler,
      );
    case 'sfi.live_setup_audit_trail':
      return runTool(
        ctx,
        args,
        liveSetupAuditTrailInputSchema,
        liveSetupAuditTrailHandler,
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
    case 'sfi.permission_set_consolidation':
      return runTool(
        ctx,
        args,
        permissionSetConsolidationInputSchema,
        permissionSetConsolidationHandler,
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
    case 'sfi.guest_exposure_report':
      return runTool(
        ctx,
        args,
        guestExposureReportInputSchema,
        guestExposureReportHandler,
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
    case 'sfi.profile_security':
      return runTool(ctx, args, profileSecurityInputSchema, profileSecurityHandler);
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
    case 'sfi.action_chain':
      return runTool(ctx, args, actionChainInputSchema, actionChainHandler);
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
    case 'sfi.automation_collisions':
      return runTool(
        ctx,
        args,
        automationCollisionsInputSchema,
        automationCollisionsHandler,
      );
    case 'sfi.ai_exposure_report':
      return runTool(
        ctx,
        args,
        aiExposureReportInputSchema,
        aiExposureReportHandler,
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
    case 'sfi.doc_coverage_report':
      return runTool(
        ctx,
        args,
        docCoverageReportInputSchema,
        docCoverageReportHandler,
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
    case 'sfi.record_creation_paths':
      return runTool(
        ctx,
        args,
        recordCreationPathsInputSchema,
        recordCreationPathsHandler,
      );
    case 'sfi.explain_flow':
      return runTool(
        ctx,
        args,
        explainFlowInputSchema,
        explainFlowHandler,
      );
    case 'sfi.flow_fault_audit':
      return runTool(
        ctx,
        args,
        flowFaultAuditInputSchema,
        flowFaultAuditHandler,
      );
    case 'sfi.flow_bulkification_audit':
      return runTool(
        ctx,
        args,
        flowBulkificationAuditInputSchema,
        flowBulkificationAuditHandler,
      );
    case 'sfi.nonselective_soql':
      return runTool(
        ctx,
        args,
        nonselectiveSoqlInputSchema,
        nonselectiveSoqlHandler,
      );
    case 'sfi.flow_graph':
      return runTool(ctx, args, flowGraphInputSchema, flowGraphHandler);
    case 'sfi.flow_trace':
      return runTool(ctx, args, flowTraceInputSchema, flowTraceHandler);
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
    case 'sfi.review_annotations':
      return runTool(ctx, args, reviewAnnotationsInputSchema, reviewAnnotationsHandler);
    case 'sfi.confirm_annotation':
      return runTool(ctx, args, confirmAnnotationInputSchema, confirmAnnotationHandler);
    case 'sfi.reject_annotation':
      return runTool(ctx, args, rejectAnnotationInputSchema, rejectAnnotationHandler);
    case 'sfi.component_history':
      return runTool(ctx, args, componentHistoryInputSchema, componentHistoryHandler);
    case 'sfi.component_change_attribution':
      return runTool(
        ctx,
        args,
        componentChangeAttributionInputSchema,
        componentChangeAttributionHandler,
      );
    case 'sfi.component_as_of':
      return runTool(ctx, args, componentAsOfInputSchema, componentAsOfHandler);
    case 'sfi.explain_error':
      return runTool(ctx, args, explainErrorInputSchema, explainErrorHandler);
    case 'sfi.explain_debug_log':
      return runTool(
        ctx,
        args,
        explainDebugLogInputSchema,
        explainDebugLogHandler,
      );
    case 'sfi.trace_debug_log':
      return runTool(ctx, args, traceDebugLogInputSchema, traceDebugLogHandler);
    case 'sfi.history_tracking_gaps':
      return runTool(
        ctx,
        args,
        historyTrackingGapsInputSchema,
        historyTrackingGapsHandler,
      );
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
    case 'sfi.picklist_integrity_scan':
      return runTool(
        ctx,
        args,
        picklistIntegrityScanInputSchema,
        picklistIntegrityScanHandler,
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
    case 'sfi.what_if_assign_permset':
      return runTool(
        ctx,
        args,
        whatIfAssignPermsetInputSchema,
        whatIfAssignPermsetHandler,
      );
    case 'sfi.what_if_revoke_permset':
      return runTool(
        ctx,
        args,
        whatIfRevokePermsetInputSchema,
        whatIfRevokePermsetHandler,
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
    case 'sfi.review_change':
      return runTool(
        ctx,
        args,
        reviewChangeInputSchema,
        reviewChangeHandler,
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
    // RM-wire — deterministic reasoning-engine surface (offline, cited).
    case 'sfi.interpret':
      return runTool(ctx, args, interpretInputSchema, interpretHandler);
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
 * Stamp the vault's ORG, on-disk PATH, and BUILDER VERSION onto every success
 * response's `vaultState` at the single dispatch choke point every tool passes
 * through, so a reader sees WHICH org / WHICH vault / WHICH extractor version
 * produced the answer on the FIRST call — the fix for silently answering from
 * the wrong org or a stale-builder vault. Central here rather than in ~157
 * inline handler sites; `run_analysis` re-dispatches through `runTool` so its
 * verbatim envelope is stamped too, and error envelopes (no `vaultState`) are
 * untouched. The three fields are optional in the contract so handlers need
 * not set them; they are always present on real success responses.
 */
/**
 * Render a vault path for disclosure with the user's HOME directory collapsed
 * to `~`, so the `vaultPath` field can name WHICH on-disk vault produced an
 * answer WITHOUT ever leaking the OS username (macOS/Linux home paths embed it,
 * e.g. `/Users/<name>/…`). The raw home prefix must never reach a client —
 * especially over the HTTP transport — so this redaction is the invariant, not
 * a cosmetic. Paths outside HOME (a system tmpdir in tests, a shared mount) are
 * returned as-is: they carry no username.
 */
const toDisclosedVaultPath = (absPath: string): string => {
  const home = homedir();
  return home.length > 0 && (absPath === home || absPath.startsWith(`${home}/`))
    ? `~${absPath.slice(home.length)}`
    : absPath;
};

const stampVaultDisclosure = <T>(
  resp: McpResponse<T>,
  ctx: Context,
): McpResponse<T> => {
  // `ctx.manifest` is always present in a real server (buildContext loads it),
  // but the response-size / leak unit tests drive `runTool` with a synthetic
  // `{} as Context`. Read defensively and stamp only the fields we actually
  // have, so a minimal ctx cannot turn a happy-path response into an internal
  // error, and the stamp stays byte-transparent when there is nothing to add.
  const manifest = ctx.manifest as
    | { readonly sourceOrg?: string; readonly version?: string }
    | undefined;
  return {
    ...resp,
    vaultState: {
      ...resp.vaultState,
      ...(typeof manifest?.sourceOrg === 'string'
        ? { targetOrg: manifest.sourceOrg }
        : {}),
      ...(typeof ctx.vaultRoot === 'string'
        ? { vaultPath: toDisclosedVaultPath(ctx.vaultRoot) }
        : {}),
      ...(typeof manifest?.version === 'string'
        ? { builderVersion: manifest.version }
        : {}),
    },
  };
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
    return jsonResult(
      result.ok
        ? stampVaultDisclosure(result.value, ctx)
        : { error: result.error },
      {
        args: parsed.data as unknown as Readonly<Record<string, unknown>>,
        knobs: narrowingKnobs(schema),
        vaultRoot: ctx.vaultRoot,
      },
    );
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
  /**
   * MCP-01 (b): always pair text (backward-compatible hosts) with
   * `structuredContent` (hosts that honor outputSchema). Text remains the
   * canonical UTF-8 budget surface.
   */
  const result = (envelope: Record<string, unknown>): CallToolResult => {
    const text = JSON.stringify(envelope);
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: envelope,
    };
  };
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
    return result({ error, estimatedPayloadBytes });
  };

  let body = bodyInput;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    // Non-object bodies are rare; keep text as the raw JSON for back-compat
    // and wrap structuredContent so it stays a JSON object (MCP requirement).
    const text = JSON.stringify(body) ?? 'null';
    if (fits(text)) {
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { value: body as unknown },
      };
    }
    return oversizeResult(Buffer.byteLength(text, 'utf8'));
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

  // AUDIT-F8: stamp content policy on success envelopes so hosts treat org
  // metadata in `data` as untrusted data (never instructions / consent).
  const withContentPolicy = (
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    isErrorEnvelope || !('data' in value)
      ? value
      : { ...value, contentPolicy: ORG_METADATA_CONTENT_POLICY };
  // Report the ORIGINAL stamped payload size (incl. contentPolicy). Trimmed
  // envelopes keep that number so hosts see pre-trim magnitude; fits() still
  // checks the final serialized text.
  const baseBytes = utf8Bytes(withContentPolicy(body as Record<string, unknown>));
  const toEnvelope = (
    value: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...withContentPolicy(value),
    estimatedPayloadBytes: baseBytes,
  });
  const original = toEnvelope(body as Record<string, unknown>);
  const originalText = JSON.stringify(original);

  if (fits(originalText)) {
    return result(original);
  }

  // Over budget: escalate on a clone — the handler's object is never mutated.
  const clone = structuredClone(body) as Record<string, unknown>;
  if (isErrorEnvelope) {
    slimDataStrings(clone);
    const trimmedError = toEnvelope(clone);
    if (fits(JSON.stringify(trimmedError))) return result(trimmedError);

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
  // SOE-omission honesty (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES):
  // when the global tail-truncation just shortened a composed-SOE `data.soe`, a
  // later automation phase `summary.phaseCounts` still claims may have been
  // dropped. Recompute + stamp `phasesOmitted` from the surviving steps (via the
  // ONE shared computePhasesOmitted) so a globally-trimmed SOE payload can never
  // silently contradict its own phaseCounts — the same envelope law the
  // tool-local `enforceSoeByteBudget` path and `order_of_execution` obey. Runs
  // BEFORE string-slimming so its bytes are inside the budget check (and the
  // long disclosure string absorbs them); a no-op on every non-SOE payload.
  if (dropped > 0) {
    reconcileSoePhasesOmittedAfterGlobalTrim((clone as { data?: unknown }).data);
  }
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
    const reduced = toEnvelope(clone);
    if (fits(JSON.stringify(reduced))) return result(reduced);
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


