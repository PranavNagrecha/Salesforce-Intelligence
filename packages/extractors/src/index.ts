/**
 * Per-metadata-type extractors.
 *
 * Each extractor is a pure async function that takes a metadata file path
 * and produces either an `ExtractionResult` (nodes + edges) or an
 * `ExtractorError`. Phase B tasks add one extractor per Salesforce
 * metadata type. Exports below are maintained in alphabetical order.
 */

export { extractApexClass } from './apex-class.js';
export { buildApexScannerEdges, mergeAndSortEdges } from './apex-edges.js';
export type { ApexEdgesResult } from './apex-edges.js';
export { extractApexTrigger } from './apex-trigger.js';
export { extractApprovalProcess } from './approval-process.js';
export { extractAssignmentRule } from './assignment-rule.js';
export { extractConditions } from './condition-extractor.js';
export type {
  ConditionExtractionResult,
  ConditionMirror,
  ConditionSource,
  CriteriaItem,
  ExtractConditionsOptions,
} from './condition-extractor.js';
export { extractAuraDefinitionBundle } from './aura-definition-bundle.js';
export { extractAuthProvider } from './auth-provider.js';
export { extractAutoResponseRule } from './auto-response-rule.js';
export { extractBusinessProcess } from './business-process.js';
export { extractConnectedApp } from './connected-app.js';
export {
  extractCpqCustomMetadataRecord,
  extractCpqCustomSettingRecord,
  specializeCpq,
} from './cpq.js';
export { extractCompactLayout } from './compact-layout.js';
export { extractCspTrustedSite } from './csp-trusted-site.js';
export { extractCustomApplication } from './custom-application.js';
export { extractCustomField } from './custom-field.js';
export { extractCustomIndex } from './custom-index.js';
export { extractCustomLabel } from './custom-label.js';
export { extractCustomMetadataRecord } from './custom-metadata-record.js';
export { extractCustomObject } from './custom-object.js';
export { extractCustomSettingRecord } from './custom-setting-record.js';
export { extractCustomTab } from './custom-tab.js';
export { extractDecisionTable } from './decision-table.js';
export {
  extractCustomPermission,
  extractDashboard,
  extractFlexiPage,
  extractListView,
  extractMutingPermissionSet,
  extractPermissionSetGroup,
  extractReport,
  extractReportType,
  extractRestrictionRule,
  extractScopingRule,
} from './enterprise-metadata.js';
export { extractDuplicateRule } from './duplicate-rule.js';
export { extractEmailTemplate } from './email-template.js';
export { extractEscalationRule } from './escalation-rule.js';
export { extractExternalDataSource } from './external-data-source.js';
export { extractExternalService } from './external-service.js';
export { extractFieldSet } from './field-set.js';
export { extractFlow } from './flow.js';
export { extractGlobalValueSet } from './global-value-set.js';
export { extractGroup } from './group.js';
export { extractInstalledPackage } from './installed-package.js';
export { extractLayout } from './layout.js';
export { extractLetterhead } from './letterhead.js';
export { extractLightningComponentBundle } from './lightning-component-bundle.js';
export { extractMatchingRule } from './matching-rule.js';
export { extractNamedCredential } from './named-credential.js';
export { extractNetworkAccess } from './network-access.js';
export { extractOmniDataTransform } from './omni-data-transform.js';
export { extractOmniIntegrationProcedure } from './omni-integration-procedure.js';
export { extractOmniScript } from './omniscript.js';
export { extractOmniUiCard } from './omni-ui-card.js';
export { extractPathAssistant } from './path-assistant.js';
export { extractPermissionSet } from './permission-set.js';
export {
  extractPlatformEventChannel,
  extractPlatformEventChannelMember,
} from './platform-event-channel.js';
export { extractProfile } from './profile.js';
export { extractQueue } from './queue.js';
export { extractQuickAction } from './quick-action.js';
export { extractRecordType } from './record-type.js';
export { extractRemoteSiteSetting } from './remote-site-setting.js';
export { extractRole } from './role.js';
export { extractSamlSsoConfig } from './saml-sso-config.js';
export { extractSharingRules } from './sharing-rules.js';
export {
  buildDescribeFieldExtraction,
  existingCustomFieldIds,
  existingCustomFieldNodes,
  fieldNeedsDescribeEnrichment,
  mergeDescribeFieldSnapshots,
  STANDARD_OBJECT_FIELD_SNAPSHOT,
} from './standard-object-describe-fields.js';
export type {
  DescribeFieldRow,
  StandardObjectFieldSnapshotName,
} from './standard-object-describe-fields.js';
export { extractStaticResource } from './static-resource.js';
export { extractValidationRule } from './validation-rule.js';
export { extractVisualforceComponent } from './visualforce-component.js';
export { extractVisualforcePage } from './visualforce-page.js';
export { extractWebLink } from './web-link.js';
export { extractWorkflowRule } from './workflow-rule.js';
