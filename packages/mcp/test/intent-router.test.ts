/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
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

import {
  allRoutableTools,
  classifyQuestion,
  gapLogPath,
  logGapIfAny,
  type Plane,
} from '../src/intent-router.js';
import type { Context } from '../src/server.js';
import { V01_TOOLS } from '../src/tools/index.js';
import {
  applyComponentTypeGuard,
  resolvedTypeForGuard,
  routeQuestionHandler,
} from '../src/tools/route-question.js';

interface Case {
  readonly q: string;
  readonly intent: string;
  readonly plane: Plane;
}

// The question battery doubles as the router spec. It spans the families the
// ~120-tool surface answers — live/operational, security/sharing/PII,
// automation/order-of-execution, code/Apex, integration, cleanup/impact,
// docs/overview, change/diff, CPQ/OmniStudio, schema — plus the owner's catalog.
const CASES: readonly Case[] = [
  // Live / operational
  { q: 'How many Accounts are in the org?', intent: 'record-count', plane: 'live' },
  { q: "Who hasn't logged in in the last 30 days?", intent: 'inactive-users', plane: 'live' },
  { q: 'Is the Industry field actually populated?', intent: 'field-population', plane: 'hybrid' },
  // PLURAL phrasings — `\b(field|value)\b` missed them (routed to metadata-count).
  { q: 'Which Account fields are empty?', intent: 'field-population', plane: 'hybrid' },
  { q: 'How many Contact fields are blank?', intent: 'field-population', plane: 'hybrid' },
  { q: 'What are the org limits right now?', intent: 'org-limits', plane: 'live' },
  { q: 'Show me 5 sample Account records', intent: 'sample-records', plane: 'live' },
  { q: 'Does the vault match production?', intent: 'drift-check', plane: 'hybrid' },

  { q: 'How many Cases by Status?', intent: 'group-count', plane: 'live' },
  { q: 'How many users are assigned to the System Administrator profile?', intent: 'profile-assignment-count', plane: 'live' },
  { q: 'Are there any inactive validation rules on the Account object?', intent: 'inactive-validation-rules', plane: 'vault' },
  { q: 'How many hardcoded values exist across configuration and code?', intent: 'hardcoded-values', plane: 'vault' },
  { q: 'Find hardcoded IDs across formulas and validation rules', intent: 'hardcoded-values-anywhere', plane: 'vault' },
  { q: 'Which permission sets grant the Delete Opportunities permission?', intent: 'object-access', plane: 'vault' },
  { q: 'Which profiles have access to the Partner record type on Account?', intent: 'recordtype-availability', plane: 'vault' },
  { q: 'Which Apex classes have not been modified in over two years?', intent: 'stale-metadata', plane: 'vault' },
  { q: 'Which queries might hit governor limits on large data volumes?', intent: 'governor-risks', plane: 'vault' },
  { q: 'What API limits are at risk given current integration volume?', intent: 'integration-capacity-risk', plane: 'hybrid' },
  { q: 'How many reports exist in this org?', intent: 'reports-inventory', plane: 'vault' },
  { q: 'Which pages have the most components and slowest load times?', intent: 'page-performance', plane: 'vault' },
  // B30.1 — metadata counts stay vault (must NOT misroute to live group-count)
  { q: 'What managed packages are installed in this org?', intent: 'package-inventory', plane: 'vault' },
  { q: 'Is this org ready for go-live release readiness?', intent: 'release-readiness', plane: 'vault' },
  { q: 'How many custom objects do we have?', intent: 'metadata-count', plane: 'vault' },
  { q: 'How many page layouts exist for Opportunity, and which is assigned to each profile?', intent: 'metadata-count', plane: 'vault' },
  { q: 'Which Accounts have not been updated in 90 days?', intent: 'stale-records', plane: 'live' },
  { q: 'What Leads were created this week?', intent: 'recent-activity', plane: 'live' },
  { q: 'What is the average Opportunity Amount?', intent: 'field-aggregate', plane: 'live' },
  { q: 'Find duplicate Contact emails', intent: 'duplicate-check', plane: 'live' },
  { q: 'How many Accounts per owner?', intent: 'owner-breakdown', plane: 'live' },
  { q: 'Which objects have the most records?', intent: 'storage-by-object', plane: 'live' },

  // Owner catalog — reports / folders / email templates
  { q: 'How many reports in the system are useless?', intent: 'reports-usage', plane: 'hybrid' },
  { q: 'What folders do people have access to for reports?', intent: 'folder-access', plane: 'live' },
  // Folder-gated ACCESS asked without the word "folder" (P11-UI-folder-access disclosure).
  { q: 'Who can see this dashboard?', intent: 'folder-access', plane: 'live' },
  { q: 'Who can access the Pipeline report?', intent: 'folder-access', plane: 'live' },
  { q: 'What email templates are used?', intent: 'email-template-usage', plane: 'hybrid' },

  // P12 access/UI tool intents — the P11 tools made routable (each must beat the
  // broader intent that used to steal it: field-access / trigger-order /
  // list-views / flexipage / schema).
  { q: 'what flows can the guest user run', intent: 'user-ability', plane: 'vault' },
  { q: 'who can run the Onboarding flow', intent: 'who-can-run', plane: 'vault' },
  { q: 'who can open the Sales Console app', intent: 'app-access', plane: 'vault' },
  { q: 'what tabs can the admin profile see', intent: 'tab-availability', plane: 'vault' },
  { q: 'who is this list view shared with', intent: 'list-view-sharing', plane: 'vault' },
  { q: 'which list views on Contact are shared with roles', intent: 'list-view-sharing', plane: 'vault' },
  { q: 'what lightning record pages does Account have', intent: 'flexipage', plane: 'vault' },
  { q: 'what record types can the admin profile create', intent: 'recordtype-availability', plane: 'vault' },
  { q: 'effective permissions for the admin profile', intent: 'effective-permissions', plane: 'vault' },
  { q: 'who can create read edit delete Account', intent: 'object-access', plane: 'vault' },
  { q: 'what happens when an Opportunity becomes Closed Won', intent: 'lifecycle-process', plane: 'vault' },
  // Bug-2 verb symmetry: "runs/fires + <transition>" must route like "happens"
  // (previously "what runs when a Lead is converted" fell through to unrouted).
  { q: 'what runs when a Lead is converted', intent: 'lifecycle-process', plane: 'vault' },
  { q: 'what fires when an Opportunity is closed won', intent: 'lifecycle-process', plane: 'vault' },
  // Access-surface sweep (real-org HEDA probe): P0/P1 routing fixes.
  // P0a — "how many users are ON the X profile" is a runtime User-record count
  // (profile-assignment-count, live), NOT a count of Profile metadata. The
  // metadata-count noun list no longer steals it (negative lookahead on "users").
  { q: 'How many users are on the System Administrator profile?', intent: 'profile-assignment-count', plane: 'live' },
  // P0b — permission set GROUPS assignment is an honest gap (tools: []), asserted
  // in a dedicated test below (the generic battery requires tools.length > 0).
  // P1a — reverse-direction templates: recordtype→profile and app→profile.
  { q: 'Which record types are available to the Sales profile?', intent: 'recordtype-availability', plane: 'vault' },
  { q: 'Which applications are assigned to the Partner profile?', intent: 'app-access', plane: 'vault' },
  { q: 'Which apps is the Admin profile assigned to?', intent: 'app-access', plane: 'vault' },
  // P1b — "what CRUD/access does {permission set} allow" verb template (the
  // "what permissions does X have" phrasing keeps effective-permissions above).
  { q: 'What CRUD access does this permission set allow?', intent: 'what-permissions-profile-has', plane: 'vault' },
  // P1c — passive voice: "what if two profiles ARE MERGED" (active "if I merge
  // profiles" already routed).
  { q: 'What if two profiles are merged?', intent: 'profile-migration', plane: 'vault' },
  // P1e — generic state transitions beyond the Opportunity/Lead hardcoded list.
  { q: 'What happens when an Application becomes Submitted?', intent: 'lifecycle-process', plane: 'vault' },
  { q: 'What runs when an Enrollment is disqualified?', intent: 'lifecycle-process', plane: 'vault' },
  // P1d — role hierarchy STRUCTURE ("which roles report up to X") beyond the
  // literal phrase "role hierarchy".
  { q: 'Which roles report up to the VP role?', intent: 'role-hierarchy-structure', plane: 'vault' },

  // P12-ROUTER-disambiguation — near-miss pairs must route to DISTINCT intents.
  { q: 'who can see Account records', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'who can view all Account records', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'what if I change Account.Industry to a text field', intent: 'what-if-field', plane: 'vault' },
  { q: 'what breaks if I change Account.Industry', intent: 'impact-analysis', plane: 'vault' },
  { q: 'governor limit risks', intent: 'governor-risks', plane: 'vault' },
  { q: 'what are my org limits', intent: 'org-limits', plane: 'live' },
  // P12-ROUTER-omni-cpq + extension-first: plural/spacing + extension phrasing.
  { q: 'what omniscripts do we have', intent: 'omnistudio', plane: 'vault' },
  { q: 'what data raptors exist', intent: 'omnistudio', plane: 'vault' },
  { q: 'what components extend the hed package', intent: 'package-impact', plane: 'vault' },

  // Security / access / sharing / PII / compliance
  { q: 'Why can\'t John see this Account record?', intent: 'why-cant-see', plane: 'vault' },
  { q: 'Which layout does the Sales profile see on Account?', intent: 'layout-access', plane: 'vault' },
  { q: 'What page layouts show the Email field?', intent: 'layout-access', plane: 'vault' },
  { q: 'How many page layouts exist for the Opportunity object?', intent: 'metadata-count', plane: 'vault' },
  { q: 'What fields are on the Case Layout page layout?', intent: 'layout-inventory', plane: 'vault' },
  { q: 'What related lists appear on the Contact page layout?', intent: 'layout-inventory', plane: 'vault' },
  { q: 'Who can edit the SSN field?', intent: 'field-access', plane: 'vault' },
  { q: 'Run a CRUD and FLS audit', intent: 'crud-fls-audit', plane: 'vault' },
  { q: 'Who is over-permissioned with Modify All Data?', intent: 'over-permission', plane: 'vault' },
  { q: 'Which profiles are over-permissioned?', intent: 'over-permission', plane: 'vault' },
  { q: 'Who can author apex?', intent: 'over-permission', plane: 'vault' },
  { q: 'Who can customize the application?', intent: 'over-permission', plane: 'vault' },
  { q: 'Who can manage users?', intent: 'over-permission', plane: 'vault' },
  { q: 'Which permission sets are unassigned?', intent: 'unassigned-permsets', plane: 'vault' },
  { q: 'Which queues are empty?', intent: 'empty-queues-groups', plane: 'vault' },
  { q: 'What is our org-wide sharing model?', intent: 'sharing-model', plane: 'vault' },
  { q: 'Help me migrate profiles to permission sets', intent: 'profile-migration', plane: 'vault' },
  { q: 'What PII do we have in the org?', intent: 'pii-inventory', plane: 'vault' },
  { q: 'Where does the SSN field flow downstream?', intent: 'pii-flow', plane: 'vault' },
  { q: 'Are we FERPA compliant?', intent: 'compliance', plane: 'vault' },

  // Automation / order-of-execution
  { q: 'What is the trigger order of Account?', intent: 'trigger-order', plane: 'vault' },
  { q: 'What happens when a Case status changes?', intent: 'trigger-order', plane: 'vault' },
  { q: 'What apex runs when a Lead is updated?', intent: 'trigger-order', plane: 'vault' },
  { q: 'Why didn\'t the Status field update on save?', intent: 'why-field-changed', plane: 'vault' },
  { q: 'What automation should I know about before building on Contact?', intent: 'automation-on-object', plane: 'vault' },
  { q: 'Which Process Builders should I migrate to Flow?', intent: 'pb-wfr-migration', plane: 'vault' },
  { q: 'What scheduled jobs do we have?', intent: 'scheduled-jobs', plane: 'vault' },
  { q: 'What does the Onboarding flow do?', intent: 'explain-flow', plane: 'vault' },
  { q: 'Which flows reference the Status field?', intent: 'flow-search', plane: 'vault' },

  // Apex / code
  { q: "What's our test coverage?", intent: 'test-coverage', plane: 'vault' },
  { q: 'Find SOQL in loops', intent: 'governor-risks', plane: 'vault' },
  // NI-7: "governor limit risks in Apex" is the static scan, NOT live org-limits
  { q: 'Where are the governor limit risks in our Apex?', intent: 'governor-risks', plane: 'vault' },
  { q: 'Are there circular dependencies in our Apex?', intent: 'dependency-cycles', plane: 'vault' },
  { q: 'Is there dead code?', intent: 'dead-code', plane: 'vault' },
  // B23 reconciliation: code-dead-code phrasings ALL route to the one canonical
  // find_dead_code (these were unrouted / mis-routed to resolve before).
  { q: 'which Apex classes are never called or unused?', intent: 'dead-code', plane: 'vault' },
  { q: 'find unreachable methods in our code', intent: 'dead-code', plane: 'vault' },
  { q: 'do we have any unused triggers?', intent: 'dead-code', plane: 'vault' },
  // ...while the broader component + field scopes keep their own canonical tools.
  { q: 'what components are unused in this org?', intent: 'unused-components', plane: 'vault' },
  { q: 'which fields are unused and safe to clean up?', intent: 'unused-fields', plane: 'hybrid' },
  { q: 'Find duplicate copy-paste code', intent: 'clone-patterns', plane: 'vault' },
  { q: 'What calls the OpportunityService class?', intent: 'call-graph', plane: 'vault' },
  { q: 'What does the AccountTrigger class do?', intent: 'explain-apex', plane: 'vault' },
  { q: 'Audit our code quality', intent: 'code-quality', plane: 'vault' },
  { q: "What's our tech debt score?", intent: 'tech-debt', plane: 'vault' },
  { q: 'Find any class that mentions Database.upsert', intent: 'apex-search', plane: 'vault' },

  // Integration
  { q: 'What integrations and named credentials do we have?', intent: 'integration-map', plane: 'vault' },
  { q: 'Who subscribes to the Order platform event?', intent: 'event-subscribers', plane: 'vault' },
  { q: 'What platform events does this org publish?', intent: 'event-catalog', plane: 'vault' },
  { q: 'What endpoints do we call out to?', intent: 'endpoints', plane: 'vault' },

  // Cleanup / impact / what-if
  { q: 'How many of our fields are actually used?', intent: 'unused-fields', plane: 'hybrid' },
  { q: 'What unused components can we delete?', intent: 'unused-components', plane: 'vault' },
  { q: 'Find every hardcoded record ID in Apex', intent: 'hardcoded-values', plane: 'vault' },
  { q: 'Is it safe to delete the Legacy_Status field?', intent: 'safe-to-delete', plane: 'vault' },
  { q: 'What breaks if I delete the Status field?', intent: 'impact-analysis', plane: 'vault' },
  { q: 'What if I make the Email field required?', intent: 'what-if-field', plane: 'vault' },
  // Value-change tier (changing stored VALUES, not schema) — must beat impact/what-if.
  { q: 'Will changing the values of FederationIdentifier and Username on User have an impact?', intent: 'value-change', plane: 'vault' },
  { q: 'Is it safe to update the External_Ref_Id__c field values?', intent: 'value-change', plane: 'vault' },
  { q: 'What breaks if I change the value of Account.Type from Customer to Partner?', intent: 'value-change', plane: 'vault' },
  { q: 'Can you let me know if changing any of these fields will have an impact on the User object — not removing the fields but changing the values?', intent: 'value-change', plane: 'vault' },
  // B21 over-route control: a field-type CHANGE is a what-if, NOT save-order —
  // the trigger-order "status changes" pattern must not steal it.
  { q: 'What happens when I change a field type?', intent: 'what-if-field', plane: 'vault' },
  { q: 'What formulas reference the Amount field?', intent: 'formula-references', plane: 'vault' },

  // Onboarding / docs / overview
  { q: 'Give me an overview of this org', intent: 'org-overview', plane: 'vault' },
  { q: 'Draw the data model / architecture', intent: 'architecture-overview', plane: 'vault' },
  { q: 'Generate a data dictionary', intent: 'data-dictionary', plane: 'vault' },
  { q: 'Generate an admin handbook', intent: 'admin-handbook', plane: 'vault' },
  { q: 'I inherited this org, walk me through it', intent: 'onboarding-doc', plane: 'vault' },
  { q: 'What functional domains is the org structured into?', intent: 'domain-clusters', plane: 'vault' },

  // Change / history / cross-org
  { q: 'What changed in the org since last week?', intent: 'history-change', plane: 'vault' },
  { q: 'Who changed this record?', intent: 'runtime-audit-trail', plane: 'vault' },
  { q: 'Show me the field history for Account.', intent: 'runtime-audit-trail', plane: 'vault' },
  { q: 'When was the Status field last modified?', intent: 'last-modified', plane: 'vault' },
  { q: "What's different between UAT and prod?", intent: 'cross-org-diff', plane: 'vault' },
  { q: 'Show me the churn between snapshots', intent: 'snapshot-diff', plane: 'vault' },

  // CPQ / OmniStudio
  { q: 'Explain the CPQ price rules', intent: 'cpq', plane: 'vault' },
  { q: 'Break down the OmniScript flow', intent: 'omnistudio', plane: 'vault' },

  // Field mapping / meaning
  { q: 'How do fields map between Lead and Contact?', intent: 'field-mapping', plane: 'vault' },
  { q: 'What does the Industry field mean?', intent: 'field-meaning', plane: 'vault' },

  // Schema / naming (general)
  { q: "What's our naming convention for date fields?", intent: 'naming-convention', plane: 'vault' },
  { q: 'What custom objects do we have?', intent: 'schema', plane: 'vault' },
  { q: 'What fields does Opportunity have?', intent: 'schema', plane: 'vault' },

  // B21.2 — Lightning record pages / FlexiPages
  { q: 'Which Lightning record pages are assigned to the Opportunity object?', intent: 'flexipage', plane: 'vault' },
  { q: 'What components are on the Account record page?', intent: 'flexipage', plane: 'vault' },

  // B21.4/5/6 — record types, validation rules, approvals
  { q: 'How do picklist values differ between record types on Case?', intent: 'record-type-picklist', plane: 'vault' },

  // P14-ROUTER-picklist-values — declared values of a NAMED picklist field
  { q: 'What values are in the Status picklist?', intent: 'picklist-values', plane: 'vault' },
  { q: 'What are the values in the Industry picklist?', intent: 'picklist-values', plane: 'vault' },
  { q: 'Which values does the Stage picklist have?', intent: 'picklist-values', plane: 'vault' },
  { q: 'List the picklist values for Case Status', intent: 'picklist-values', plane: 'vault' },
  { q: 'What picklist values does Account.Industry have?', intent: 'picklist-values', plane: 'vault' },
  { q: 'What are the possible values for the Payment Status field?', intent: 'picklist-values', plane: 'vault' },
  // Collision guards: record-type value diffs keep their specialist route
  // (rule order), and removal simulations stay what-if.
  { q: 'Which picklist values are available for the Support record type?', intent: 'record-type-picklist', plane: 'vault' },
  { q: 'What happens if I remove the Closed Won picklist value?', intent: 'what-if-field', plane: 'vault' },

  // P14-ROUTER-cmdt-record-values — configured CMDT / Custom Setting RECORD values
  { q: 'What is the Default record of Marketo_Api_Setting__mdt set to?', intent: 'cmdt-record-values', plane: 'vault' },
  { q: 'What values does the US record of Region_Config__mdt hold?', intent: 'cmdt-record-values', plane: 'vault' },
  { q: 'Show the values in the Region_Config__mdt records', intent: 'cmdt-record-values', plane: 'vault' },
  { q: 'Look up the Default record of Marketo_Api_Setting__mdt', intent: 'cmdt-record-values', plane: 'vault' },
  { q: 'What is Api_Timeout set to in the Batch_Config custom setting?', intent: 'cmdt-record-values', plane: 'vault' },
  // Suffix-dropped CMDT type name (gallery-proven phrasing) — the snake_case
  // token cues the route; a __c token must NOT land here.
  { q: 'What values are in Status_Processor_Rule AffiliationWorking?', intent: 'cmdt-record-values', plane: 'vault' },
  // Collision guards: type-level browse stays custom-settings-cmdt; the
  // picklist-values and record-type-picklist phrasings are untouched; real
  // record-sample asks keep the live plane (the __mdt carve must not leak).
  { q: 'What custom settings exist and what do they store?', intent: 'custom-settings-cmdt', plane: 'vault' },
  { q: 'What custom metadata types do we have?', intent: 'custom-settings-cmdt', plane: 'vault' },
  { q: 'Show me 5 sample Account records', intent: 'sample-records', plane: 'live' },

  // P14-ROUTER-object-create-access — SINGLE-verb create/delete is object-level CRUD
  { q: 'Who can create an Account record?', intent: 'object-access', plane: 'vault' },
  { q: 'Who can delete Cases?', intent: 'object-access', plane: 'vault' },
  { q: 'Which profiles can create Opportunities?', intent: 'object-access', plane: 'vault' },
  // Collision guards: field-level edit stays field-access; record-level
  // see/edit keeps who-can-access-object; past-tense WHO-did asks keep the
  // runtime audit-trail route.
  { q: 'Who can edit Contact.Email?', intent: 'field-access', plane: 'vault' },
  { q: 'Who can see Account records?', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'Who deleted the opportunity?', intent: 'runtime-audit-trail', plane: 'vault' },

  // P14-ROUTER-live-count-temporal — temporal qualifier cues live data even
  // when the object noun isn't in the record-count noun list.
  { q: 'How many open applications do we have right now?', intent: 'record-count', plane: 'live' },
  { q: 'How many active enrollments are there currently?', intent: 'record-count', plane: 'live' },
  { q: 'What is the count of open tickets today?', intent: 'record-count', plane: 'live' },
  // Collision guards: metadata nouns keep the vault metadata-count route
  // (earlier rule), and "how many X" with no temporal/noun cue stays put.
  { q: 'How many validation rules do we have right now?', intent: 'metadata-count', plane: 'vault' },

  // P14-ROUTER-community-security-compound — a long compound security ask was
  // dragged onto the LIVE email-template tool by a cross-clause "templates …
  // used" match, then onto app-access by the bare \bapp prefix ("application
  // templates"). It must land in the vault ACCESS family; the real email- and
  // app-phrasings keep their intents.
  {
    q: 'We are hardening the partner community before go-live. Besides object-level sharing on Application__c, we need to know what Community_Login_Flow and related flows do on login, which profiles and permission sets grant access to application templates and educational history child objects, and whether any named credentials used by the community run in user mode versus system mode. Please summarize from vault metadata only.',
    intent: 'field-access',
    plane: 'vault',
  },
  { q: 'Which email templates are unused?', intent: 'email-template-usage', plane: 'hybrid' },
  { q: 'What templates are used the most?', intent: 'email-template-usage', plane: 'hybrid' },
  { q: 'Which profiles can access the Sales app?', intent: 'app-access', plane: 'vault' },
  { q: 'Who can open the Service Console application?', intent: 'app-access', plane: 'vault' },

  // P14-ROUTER-safe-delete-misroute — a compound delete-verdict question
  // enumerates nouns ("every layout, validation rule, flow, … permission
  // set"), and the first broad noun rule used to win (unassigned-permsets).
  // The product-vocabulary cues (safe-to-delete verdict / block deletion /
  // before deleting) now outrank every noun enumeration via the early
  // precision rule; the neighbors keep their plain phrasings.
  {
    q: 'We think Account.Description is unused legacy text from a prior implementation. Before deleting it in a sandbox, I need to know every layout, validation rule, flow, formula field, and permission set that still references Account.Description, and whether the platform would block deletion or only warn us. What is the safe-to-delete verdict and confidence level?',
    intent: 'safe-to-delete',
    plane: 'vault',
  },
  { q: 'What is the safe-to-delete verdict for Status__c?', intent: 'safe-to-delete', plane: 'vault' },
  { q: 'Which permission sets are unassigned?', intent: 'unassigned-permsets', plane: 'vault' },
  { q: 'What breaks if I delete Account.Industry?', intent: 'impact-analysis', plane: 'vault' },

  // P14-ROUTER-goldset-expand — top baseline-300 unrouted clusters + the
  // two grandfathered tools with real phrasings.
  { q: 'When did the Status field change?', intent: 'component-history', plane: 'vault' },
  { q: 'Show the change history of the Payment flow', intent: 'component-history', plane: 'vault' },
  { q: 'Who owns the Status field?', intent: 'annotations-owner', plane: 'vault' },
  { q: 'What is the help text for the Discount_Percent__c field?', intent: 'field-meaning', plane: 'vault' },
  { q: 'What is the relationship between Account and Contact?', intent: 'schema', plane: 'vault' },
  { q: 'What are the child objects of Case?', intent: 'schema', plane: 'vault' },
  { q: 'Which validation rules reference the Stage field?', intent: 'formula-references', plane: 'vault' },
  { q: 'What permissions does the Sales User profile have?', intent: 'effective-permissions', plane: 'vault' },
  // Collision guards: live record ownership stays owner-breakdown; the
  // org-declared stamp stays last-modified; org-wide diffs stay
  // history-change; noun-final usage stays component-usage.
  { q: 'Who owns the most Account records?', intent: 'owner-breakdown', plane: 'live' },
  { q: 'When was the Status field last modified?', intent: 'last-modified', plane: 'vault' },
  { q: 'What changed recently in the org?', intent: 'history-change', plane: 'vault' },

  // P14-ROUTER-stress-20 — the refresh-anchored churn phrasing gets the
  // no-arg specialist; generic churn/trend keeps the snapshot tools.
  { q: 'Churn since last vault refresh', intent: 'what-changed-since-refresh', plane: 'vault' },
  // "what changed since…" stays with the EARLIER history-change rule
  // (org_history — also no-arg callable), an established route.
  { q: 'What changed since the last refresh?', intent: 'history-change', plane: 'vault' },
  { q: 'How much churn did we have over time?', intent: 'snapshot-diff', plane: 'vault' },

  // P14-ROUTER-method-signature-impact — the specialist simulator wins the
  // signature phrasings the generic blast-radius rule was swallowing.
  { q: 'What breaks if I change the signature of a method in OpportunityService?', intent: 'what-if-method-signature', plane: 'vault' },
  { q: 'What if I change the method signature of calculateTotal in PaymentService?', intent: 'what-if-method-signature', plane: 'vault' },
  { q: 'Is it safe to change the signature of MergeCases.merge?', intent: 'what-if-method-signature', plane: 'vault' },
  // Collision guards: non-signature blast-radius asks keep impact-analysis.
  { q: 'What breaks if I change Account.Industry?', intent: 'impact-analysis', plane: 'vault' },
  { q: 'What is the blast radius of changing Contact.Email?', intent: 'impact-analysis', plane: 'vault' },

  // P14-ROUTER-formula-vs-usage — verb-first formula/VR phrasings leave component-usage
  { q: 'What references Account.Industry in formulas or validation rules?', intent: 'formula-references', plane: 'vault' },
  { q: 'What uses Status__c in validation rules?', intent: 'formula-references', plane: 'vault' },
  // Collision guards: generic usage phrasings keep their existing routes.
  { q: 'Where is MergeCases used?', intent: 'component-usage', plane: 'vault' },
  { q: 'What references the Amount_Required validation rule?', intent: 'component-usage', plane: 'vault' },
  { q: 'What does the validation rule Close_Date_Required enforce?', intent: 'explain-validation-rule', plane: 'vault' },
  // NI-11: "...validation rule on <object> enforce" must NOT be stolen by automation-on-object
  { q: 'What does the FacultyEdit validation rule on Account enforce?', intent: 'explain-validation-rule', plane: 'vault' },
  { q: 'What error message does the Phone_Format validation rule show?', intent: 'explain-validation-rule', plane: 'vault' },
  { q: 'What are the approval steps for the Discount Approval process?', intent: 'approval-process', plane: 'vault' },
  { q: 'What approval processes exist on the Opportunity object?', intent: 'approval-process', plane: 'vault' },

  // B21.8/9/10 — list views, custom settings/CMDT, profile compare
  { q: 'What list views are available on the Lead object?', intent: 'list-views', plane: 'vault' },
  { q: 'What custom settings exist and what do they store?', intent: 'custom-settings-cmdt', plane: 'vault' },
  { q: 'What is the difference between the Sales Manager and Sales Rep profiles?', intent: 'compare-profiles', plane: 'vault' },
  // B21.15 — inbound Apex REST (must beat the outbound `endpoints` catalog)
  { q: 'What Apex REST endpoints are exposed?', intent: 'rest-endpoints', plane: 'vault' },
  // B21.16/17 — interface implementers (Schedulable / Batchable)
  { q: 'Which classes implement the Database.Batchable interface?', intent: 'interface-implementers', plane: 'vault' },
  { q: 'Which Apex classes implement Schedulable?', intent: 'interface-implementers', plane: 'vault' },

  // B1 — knowledge plane (greenfield best-practice; no org-specific answer)
  { q: 'When should I use a record-triggered Flow versus an Apex trigger?', intent: 'guidance', plane: 'knowledge' },
  { q: 'What Apex trigger framework pattern should I adopt?', intent: 'guidance', plane: 'knowledge' },
  { q: 'What asynchronous Apex options exist and when is each appropriate?', intent: 'guidance', plane: 'knowledge' },
  { q: 'How do I set up source-driven development with SFDX?', intent: 'guidance', plane: 'knowledge' },
  { q: 'How should I structure unlocked packages for a new project?', intent: 'guidance', plane: 'knowledge' },
  { q: 'How should I decide between a single-org and a multi-org strategy?', intent: 'guidance', plane: 'knowledge' },
  { q: 'What data retention and archiving strategy should I design up front?', intent: 'guidance', plane: 'knowledge' },
  { q: 'How should I plan for large data volumes from the start?', intent: 'guidance', plane: 'knowledge' },

  // TEST-SANDBOX-ROUTER-first-user — verbatim misses from the real-org probe.
  { q: 'How many Opportunities are there?', intent: 'record-count', plane: 'live' },
  { q: 'Show me 5 Opportunities', intent: 'sample-records', plane: 'live' },
  { q: 'Is the vault fresh?', intent: 'vault-health', plane: 'vault' },
  { q: 'Which Apex classes have security issues?', intent: 'code-quality', plane: 'vault' },
  { q: 'Are there any Apex classes without test classes?', intent: 'test-coverage', plane: 'vault' },
  { q: 'What Apex classes exist in this org?', intent: 'schema', plane: 'vault' },
  { q: 'What is the API version of AccountSelector?', intent: 'schema', plane: 'vault' },
  { q: 'Which Apex classes are marked without sharing?', intent: 'code-quality', plane: 'vault' },
  { q: 'Which flows are currently inactive?', intent: 'inactive-flows', plane: 'vault' },
  { q: 'What standard objects are available in this org?', intent: 'schema', plane: 'vault' },
  { q: 'What values are in Academic Eligibility?', intent: 'picklist-values', plane: 'vault' },
  { q: 'Who can access Experiential Education History?', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'Where is the experiential education history object?', intent: 'schema', plane: 'vault' },
  { q: 'How many active users are in this org?', intent: 'record-count', plane: 'live' },
  { q: 'how many active users', intent: 'record-count', plane: 'live' },
  { q: 'How many users have Modify All Data and is that appropriate?', intent: 'over-permission', plane: 'vault' },
  { q: 'What can you do?', intent: 'capabilities', plane: 'vault' },
  // Collision: object names containing "history" must not steal history-change.
  { q: 'What changed recently in the org?', intent: 'history-change', plane: 'vault' },

  // Admin-edge 61–90: explicit tool-name phrasing (regex must route without funnel).
  { q: 'release_readiness_report — is this org ready for release?', intent: 'release-readiness', plane: 'vault' },
  // tech_debt_score literal-echo rule removed (I5 slim-down); the tool ranks #1
  // in the funnel, so the tool-name-only phrasing is no longer a regex route.
  { q: 'coverage_report — which metadata families were retrieved vs notModeled?', intent: 'vault-health', plane: 'vault' },
  { q: 'retrieve_blindspot_report — what is not being pulled?', intent: 'retrieve-blindspot', plane: 'vault' },
  { q: 'automation_build_advisor Contact — when it cites active record-triggered Flows', intent: 'automation-on-object', plane: 'vault' },
  { q: 'automation_risk_report — which objects have the most stacked automation?', intent: 'automation-risk', plane: 'vault' },
  { q: 'apex_build_advisor for a new trigger on hed__Example_Course__c', intent: 'apex-build-advisor', plane: 'vault' },
  { q: 'order_of_execution Contact update — after-trigger phase', intent: 'trigger-order', plane: 'vault' },
  { q: 'field_mapping_between_objects Lead→Contact — heuristic conversion map', intent: 'field-mapping', plane: 'vault' },
  { q: 'apex_test_coverage CalculatePaymentsBatch — specific coverage', intent: 'test-coverage', plane: 'vault' },
  { q: 'find_clone_patterns — Copy_of_* flows near-duplicates', intent: 'clone-patterns', plane: 'vault' },
  { q: 'get_impact Contact.hed__Social_Security_Number__c hops=2', intent: 'impact-analysis', plane: 'vault' },
  { q: 'disambiguate_concepts — is Status the same concept as Stage?', intent: 'disambiguate-concepts', plane: 'vault' },
  { q: 'field_provenance Contact.Best_Military_Status__c — source of truth', intent: 'field-provenance', plane: 'vault' },
  { q: 'lookup_record on CustomMetadata Faculty_Management Hours_Limit_Year', intent: 'cmdt-record-values', plane: 'vault' },
  { q: 'last_modified CalculatePaymentsBatch — who built it and when', intent: 'last-modified', plane: 'vault' },
  { q: 'live_field_population — how many Contacts have Military_Status__c populated', intent: 'field-population', plane: 'hybrid' },
  { q: 'field_change_advisor Contact.Best_Status__c — advice on changing it', intent: 'field-change-advisor', plane: 'vault' },
  { q: 'what_if_change_field_value / value_change_audit — blast radius', intent: 'value-change', plane: 'vault' },
  { q: 'compare_object_across_vaults Contact sandbox-vs-prod', intent: 'cross-org-diff', plane: 'vault' },
  { q: 'find_dependency_cycles — circular Apex dependencies', intent: 'dependency-cycles', plane: 'vault' },
  { q: 'downstream_effects of changing MRK_SessionHandler', intent: 'downstream-effects', plane: 'vault' },
  { q: 'tests_for_change ApplicationValidationService', intent: 'tests-for-change', plane: 'vault' },

  // Admin-edge 31–60: explicit tool-name phrasing.
  { q: 'field_lineage on Contact.CB_CE_Yearly_URL__c upstream', intent: 'pii-flow', plane: 'vault' },
  { q: 'field_360 on Contact.hed__Social_Security_Number__c — riskLevel', intent: 'field-meaning', plane: 'vault' },
  { q: 'safe_to_delete_field Contact.Email — standard field undeletable', intent: 'safe-to-delete', plane: 'vault' },
  { q: 'what_if_make_field_required Contact.Email', intent: 'what-if-field', plane: 'vault' },
  // scheduled_job_catalog / endpoint_catalog: pure literal-echo recall-crutch
  // rules removed in the I5 funnel-primary slim-down. For a tool-name-only
  // phrasing with no prose signal the funnel is now the recall net (it ranks
  // both tools #1), so they are no longer asserted as deterministic regex routes.
  { q: 'async_chain_depth from CalculatePaymentsBatch', intent: 'async-chain-depth', plane: 'vault' },
  { q: 'governor_limit_risks — SOQL in loops', intent: 'governor-risks', plane: 'vault' },
  { q: 'find_dead_code — unreachable Apex', intent: 'dead-code', plane: 'vault' },
  { q: 'meaningful_test_audit on the FSR_Trigger* test family', intent: 'test-coverage', plane: 'vault' },

  // Eval Family A — schema nouns are INTENT signals, never entity lookups.
  // Each of these previously blocked on a menu of unrelated components (or
  // fell through to schema/unrouted) because a bare noun ("trigger",
  // "profile") in the phrasing was shopped to the resolver as a component name.
  { q: 'Which flows fire before the Contact trigger and which run after?', intent: 'trigger-order', plane: 'vault' },
  { q: 'what actually happens on save for a Contact — every trigger, flow, and validation rule', intent: 'trigger-order', plane: 'vault' },
  { q: 'List every profile with delete permission on Contact', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'Show me every profile that can access Case', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'Which profiles have delete permission on Contact?', intent: 'who-can-access-object', plane: 'vault' },
  { q: 'What is a Profile?', intent: 'guidance', plane: 'knowledge' },
  { q: 'what is a permission set', intent: 'guidance', plane: 'knowledge' },
  // The generic-article compare stays on compare-profiles per the pinned
  // access-surface fixture — the fix is that it never raises an entity menu.
  { q: 'difference between a profile and a permission set', intent: 'compare-profiles', plane: 'vault' },
];

describe('classifyQuestion battery', () => {
  for (const c of CASES) {
    it(`routes "${c.q}" -> ${c.intent}/${c.plane}`, () => {
      const r = classifyQuestion(c.q);
      expect(r.intent).toBe(c.intent);
      expect(r.plane).toBe(c.plane);
      expect(r.tools.length).toBeGreaterThan(0);
    });
  }

  it('covers a broad surface (>= 40 distinct intents)', () => {
    const intents = new Set(CASES.map((c) => classifyQuestion(c.q).intent));
    expect(intents.size).toBeGreaterThanOrEqual(40);
  });
});

describe('Family A — schema nouns as intent signals, object binding, concept routing', () => {
  it('binds the OBJECT (never the DML noun) for "on save for a Contact" phrasings', () => {
    // deriveObjectApiFromQuestion used to capture "on SAVE" as the object and
    // emit `objectApiName: 'save'`; the preposition scan now skips DML nouns
    // and binds the real object from "for a Contact".
    expect(
      classifyQuestion('what happens on save for a Contact').suggestedArgs,
    ).toEqual({ event: 'update', objectApiName: 'Contact' });
    expect(
      classifyQuestion(
        'what actually happens on save for a Contact — every trigger, flow, and validation rule',
      ).suggestedArgs,
    ).toEqual({ event: 'update', objectApiName: 'Contact' });
  });

  it('"What is a Profile" carries the profiles-vs-permission-sets knowledge topic', () => {
    const r = classifyQuestion('What is a Profile?');
    expect(r.intent).toBe('guidance');
    expect(r.plane).toBe('knowledge');
    expect(r.suggestedArgs).toEqual({ topic: 'profiles-vs-permission-sets' });
    expect(r.needsResolve).toBe(false);
  });

  it('the named compare ("Sales Manager vs Sales Rep profiles") keeps compare-profiles', () => {
    const r = classifyQuestion(
      'What is the difference between the Sales Manager and Sales Rep profiles?',
    );
    expect(r.intent).toBe('compare-profiles');
    expect(r.plane).toBe('vault');
  });
});

describe('classifyQuestion edge cases', () => {
  it('returns unknown + a gap for an unroutable question', () => {
    const r = classifyQuestion('what is the meaning of life');
    expect(r.plane).toBe('unknown');
    expect(r.intent).toBe('unrouted');
    expect(r.gap).not.toBeNull();
    expect(r.tools).toContain('sfi.resolve');
  });

  it('returns unknown for an empty question', () => {
    const r = classifyQuestion('   ');
    expect(r.plane).toBe('unknown');
    expect(r.intent).toBe('empty');
  });

  it('routes "which permission set groups are assigned to nobody" to an honest gap (P0b)', () => {
    // PermissionSetGroup assignment is not modeled; the router must NOT fall
    // through to unassigned_permission_sets (PermissionSet-only), which would be
    // confidently wrong. It returns an empty tool list plus a capability gap.
    for (const q of [
      'Which permission set groups are assigned to nobody?',
      'Are there any unused permission set groups?',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('unassigned-permset-groups');
      expect(r.tools).toHaveLength(0);
      expect(r.gap).not.toBeNull();
      expect(r.gap?.category).toBe('unassigned-permset-groups');
    }
  });

  it('routes runtime audit-trail questions to an honest disclosure (P11-WHATHAPPENED-disclosure)', () => {
    for (const q of [
      'who changed this record',
      'who deleted the opportunity',
      'setup audit trail',
      'what is the debug log',
      'what happened to this account',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('runtime-audit-trail');
      // Honest: not a dead unknown, points at the metadata-side fallbacks…
      expect(r.plane).toBe('vault');
      expect(r.tools).toContain('sfi.last_modified');
      // …with a disclosure naming the runtime boundary.
      expect(r.gap?.category).toBe('runtime-audit-trail');
      expect(r.gap?.note).toMatch(/audit trail|runtime/i);
    }
  });

  it('does NOT divert metadata history / causality questions to the audit disclosure', () => {
    // "what changed since refresh" is a metadata diff; "why did X change" is
    // metadata causality — neither is a runtime audit-trail ask.
    expect(classifyQuestion('what changed since the last refresh').intent).toBe('history-change');
    expect(classifyQuestion('why did the Status field change').intent).toBe('why-field-changed');
  });

  it('flags needsResolve when a component is named informally', () => {
    expect(classifyQuestion('who can edit the SSN field?').needsResolve).toBe(true);
    expect(classifyQuestion('what are the org limits?').needsResolve).toBe(false);
  });

  it('does NOT gap routes with dedicated live tools', () => {
    expect(classifyQuestion('how many reports are useless?').gap).toBeNull();
    expect(classifyQuestion('what email templates are used?').gap).toBeNull();
  });

  it('routes folder-gated access to the live plane WITH an honest offline disclosure', () => {
    for (const q of [
      'Who can see this dashboard?',
      'Who can access the Pipeline report?',
      'What folders do people have access to for reports?',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('folder-access');
      expect(r.plane).toBe('live');
      expect(r.tools).toContain('sfi.live_folder_access');
      // Honest: discloses that folder shares are not in the offline vault.
      expect(r.gap?.category).toBe('folder-access');
      expect(r.gap?.note).toMatch(/offline|FolderShare|not retrieved/i);
    }
  });

  it('does NOT gap a well-covered route', () => {
    expect(classifyQuestion('what custom objects do we have?').gap).toBeNull();
    expect(classifyQuestion('what is the trigger order of Account?').gap).toBeNull();
  });

  it('routes REVERSE layout questions to layout_assignments, not the forward layout_for_user (P12-ROUTER-layout-assignments)', () => {
    for (const q of [
      'what is the Account Layout assigned to',
      'which profiles use the Account Layout',
      'who is assigned the Account Layout',
      'show me the layout assignments for the Account Layout',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('layout-assignments');
      expect(r.tools).toContain('sfi.layout_assignments');
      expect(r.tools).not.toContain('sfi.layout_for_user');
      expect(r.plane).toBe('vault');
    }
    // The FORWARD "which layout does a user see" must stay on layout_for_user.
    const fwd = classifyQuestion('which layout does the Sales profile see on Account');
    expect(fwd.intent).toBe('layout-access');
    expect(fwd.tools).toContain('sfi.layout_for_user');
  });

  it('routes the core ask when wrapped in role/provenance instructions', () => {
    const r = classifyQuestion(
      'For an architect impact review, answer this with canonical IDs and provenance: Can you send email to users? [unsupported-boundary 4]',
    );
    expect(r.plane).toBe('unknown');
    expect(r.intent).toBe('unrouted');
  });

  it('routes "which flows run when ... created" instead of gapping (B21)', () => {
    for (const q of [
      'Which flows run when a Case is created?',
      'which triggers fire when an Account is updated',
      'what validation rules run when a Contact is inserted',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('trigger-order');
      expect(r.gap).toBeNull();
    }
  });

  it("trigger-order reason hints the default DML event (B14)", () => {
    const r = classifyQuestion('what happens when an Account is saved?');
    expect(r.intent).toBe('trigger-order');
    expect(r.reason).toMatch(/event/i);
    expect(r.reason).toMatch(/update/);
  });

  it('flow-search derives the grep query from the content words (P14-ROUTER-stress-20)', () => {
    const r = classifyQuestion('Marketo applicant status sync flows');
    expect(r.intent).toBe('flow-search');
    // Routing scaffolding stripped; the named content remains as the query.
    expect(r.suggestedArgs).toEqual({ query: 'marketo applicant status sync' });
    const r2 = classifyQuestion('which flows reference the Budget_Group field?');
    expect(r2.intent).toBe('flow-search');
    expect(r2.suggestedArgs).toEqual({ query: 'budget_group field' });
  });

  it('trigger-order returns a suggestedArgs DML event matching the verb (B14)', () => {
    expect(
      classifyQuestion('what happens when a Contact is created?').suggestedArgs,
    ).toEqual({ event: 'insert' });
    expect(
      classifyQuestion('what happens when a Contact is updated?').suggestedArgs,
    ).toEqual({ event: 'update' });
    expect(
      classifyQuestion('what runs when a Case is deleted?').suggestedArgs,
    ).toEqual({ event: 'delete' });
    expect(
      classifyQuestion('what fires when a record is undeleted?').suggestedArgs,
    ).toEqual({ event: 'undelete' });
    // Implicit / status-change phrasings default to update.
    expect(
      classifyQuestion('what happens when an Account is saved?').suggestedArgs,
    ).toEqual({ event: 'update' });
    expect(
      classifyQuestion('what happens when a Case status changes?')
        .suggestedArgs,
    ).toEqual({ event: 'update' });
  });

  it('omits suggestedArgs for intents with no derivable args (B14)', () => {
    expect(
      classifyQuestion('what PII do we have?').suggestedArgs,
    ).toBeUndefined();
    expect(
      classifyQuestion('give me an overview of this org').suggestedArgs,
    ).toBeUndefined();
  });

  it('schema route suggests the list_components `type` for enumerations (P1-B14-exec)', () => {
    // list_components REQUIRES `type` (v0.1 contract), so a discovery enumeration
    // would error "type is required" without this hint.
    const cases: ReadonlyArray<{ readonly q: string; readonly type: string }> = [
      { q: 'What validation rules exist?', type: 'ValidationRule' },
      { q: 'What record types do we have?', type: 'RecordType' },
      { q: 'List all flows', type: 'Flow' },
      { q: 'What custom objects do we have?', type: 'CustomObject' },
    ];
    for (const { q, type } of cases) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('schema');
      expect(r.tools[0]).toBe('sfi.list_components');
      expect(r.suggestedArgs).toEqual({ type });
    }
    expect(classifyQuestion('Duplicate rules on Lead').suggestedArgs).toEqual({
      type: 'DuplicateRule',
      parentId: 'CustomObject:Lead',
    });
  });

  it('metadata-count suggests flow filters for record-triggered flow counts (differential b1-a-03)', () => {
    expect(
      classifyQuestion(
        'How many active record-triggered flows are on hed__Application__c?',
      ).suggestedArgs,
    ).toEqual({
      type: 'Flow',
      status: 'Active',
      recordTriggered: true,
      triggerObject: 'hed__Application__c',
    });
  });

  it('routes Apex triggers on object to automation-on-object (differential b1-a-06)', () => {
    const r = classifyQuestion('What Apex triggers fire on Payment__c?');
    expect(r.intent).toBe('automation-on-object');
    expect(r.tools).toContain('sfi.automation_build_advisor');
    expect(r.suggestedArgs).toEqual({ objectApiName: 'Payment__c' });
  });

  it('routes permission-set object access to object-access (differential b1-a-05)', () => {
    const r = classifyQuestion(
      'Which permission sets grant object access to Payment__c?',
    );
    expect(r.intent).toBe('object-access');
    expect(r.tools).toContain('sfi.object_access_audit');
  });

  it('metadata-count suggests ValidationRule parentId (differential b2-a-01)', () => {
    expect(
      classifyQuestion('How many validation rules are on hed__Application__c?')
        .suggestedArgs,
    ).toEqual({
      type: 'ValidationRule',
      parentId: 'CustomObject:hed__Application__c',
    });
  });

  it('field-mapping suggests objectA/objectB for Lead→Contact phrasing', () => {
    expect(
      classifyQuestion('field_mapping_between_objects Lead→Contact — heuristic conversion map')
        .suggestedArgs,
    ).toEqual({ objectA: 'Lead', objectB: 'Contact' });
    expect(classifyQuestion('How do fields map between Lead and Contact?').suggestedArgs).toEqual({
      objectA: 'Lead',
      objectB: 'Contact',
    });
  });

  it('routes EncryptedText field lists to schema CustomField inventory (admin-edge 141-190)', () => {
    const r = classifyQuestion('List the EncryptedText fields on Contact.');
    expect(r.intent).toBe('schema');
    expect(r.suggestedArgs).toEqual({ type: 'CustomField', parentId: 'CustomObject:Contact' });
  });

  it('routes report type inventory to vault list_components (not live_report_usage)', () => {
    expect(classifyQuestion('Are there custom report types joining Account to Opportunity to Case?').intent).toBe(
      'report-type-inventory',
    );
    expect(
      classifyQuestion('Are there custom report types joining Account to Opportunity to Case?').tools,
    ).toEqual(['sfi.list_components', 'sfi.get_component']);
    expect(
      classifyQuestion('Which report types are based on a standard object but include custom-object joins (e.g., Contact plus a HED object)?').intent,
    ).toBe('report-type-inventory');
  });

  it('routes unplaced fields and compact-layout compare (admin-edge 141-190)', () => {
    expect(
      classifyQuestion(
        'Are there fields that exist but are not placed on any layout (hidden but present)?',
      ).intent,
    ).toBe('field-layout-coverage');
    expect(
      classifyQuestion(
        'Which compact-layout fields show in Contact highlights vs the full page layout?',
      ).intent,
    ).toBe('layout-inventory');
    expect(
      classifyQuestion('layout_for_user: which layout does a Faculty-profile user get for Case?')
        .suggestedArgs,
    ).toEqual({ objectApiName: 'Case', profileId: 'Profile:Faculty' });
  });

  it('routes update save-order on hed__Application__c (differential b2-a-05)', () => {
    const r = classifyQuestion(
      'What happens when I update hed__Application__c — which validation rules, flows, and triggers run?',
    );
    expect(r.intent).toBe('trigger-order');
    expect(r.tools).toContain('sfi.what_happens_on_save');
    expect(r.suggestedArgs).toMatchObject({
      event: 'update',
      objectApiName: 'hed__Application__c',
    });
  });

  it('routes Modify All permission sets to object-access (differential b3-a-02)', () => {
    const r = classifyQuestion(
      'Which permission sets grant Modify All Records on Contact?',
    );
    expect(r.intent).toBe('object-access');
    expect(r.tools).toContain('sfi.object_access_audit');
  });

  it('routes flow system-mode questions to explain-flow (differential b3-a-04)', () => {
    const r = classifyQuestion(
      'Does flow Create_Flags_from_Contact run in System Mode Without Sharing, and what sharing risk does that create?',
    );
    expect(r.intent).toBe('explain-flow');
    expect(r.tools).toContain('sfi.explain_flow');
  });

  it('routes automation step counts to trigger-order (differential b3-a-05)', () => {
    const r = classifyQuestion(
      'How many automation steps run on an hed__Application__c update (before-save flows, validation rules, after-save flows, async)?',
    );
    expect(r.intent).toBe('trigger-order');
    expect(r.tools).toContain('sfi.what_happens_on_save');
    expect(r.suggestedArgs?.objectApiName).toBe('hed__Application__c');
  });

  it('schema route suggests parent-scoped CustomField list for field inventory (FLD-05)', () => {
    expect(
      classifyQuestion('What fields does Opportunity have?').suggestedArgs,
    ).toEqual({ type: 'CustomField', parentId: 'CustomObject:Opportunity' });
  });

  it('omnistudio discovery leads with list_components + sub-family type (P1-B14-exec)', () => {
    // The per-component breakdown tools need a specific id the router cannot
    // derive, so a discovery ask leads with the catalog list_components call.
    const om = classifyQuestion('OmniStudio admission scripts');
    expect(om.intent).toBe('omnistudio');
    expect(om.tools[0]).toBe('sfi.list_components');
    expect(om.suggestedArgs).toEqual({ type: 'OmniScript' });
    expect(
      classifyQuestion('What integration procedures exist?').suggestedArgs,
    ).toEqual({ type: 'OmniIntegrationProcedure' });
    expect(classifyQuestion('List our DataRaptors').suggestedArgs).toEqual({
      type: 'OmniDataTransform',
    });
    expect(classifyQuestion('FlexCards in this org').suggestedArgs).toEqual({
      type: 'OmniUiCard',
    });
  });

  it('cpq discovery leads with the no-id org-wide dependency map (P1-B14-exec)', () => {
    const r = classifyQuestion('CPQ quote line dependencies');
    expect(r.intent).toBe('cpq');
    // cpq_dependency_map takes an OPTIONAL id, so it runs org-wide with no args —
    // cpq_rule_chain/quote_template_breakdown (which require an id) follow.
    expect(r.tools[0]).toBe('sfi.cpq_dependency_map');
  });

  it('routes "which permission sets allow read on X" to field-access (B21)', () => {
    const r = classifyQuestion('which permission sets allow read on Account?');
    expect(r.intent).toBe('field-access');
    expect(r.gap).toBeNull();
  });

  it('routes 1000Q regression-bank phrasing without route gaps (B21 / 0.1.6)', () => {
    const cases: ReadonlyArray<{ readonly q: string; readonly intent: string }> = [
      { q: 'Where is the where is email on contact?', intent: 'locate-field' },
      { q: 'Is Account.Name in any page layouts?', intent: 'layout-inventory' },
      { q: 'What if we deactivate ADA_Accom_Flow_Attribute_Flows?', intent: 'impact-analysis' },
      { q: 'Run automation risk for regression', intent: 'automation-risk' },
      { q: 'What runs on Account insert?', intent: 'trigger-order' },
      {
        q: 'Before adding automation on Account, what exists?',
        intent: 'automation-on-object',
      },
      { q: 'Validation rules on Application_Event__e', intent: 'schema' },
      { q: 'Platform events in this org', intent: 'event-catalog' },
      { q: 'Show event subscribers', intent: 'event-subscribers' },
      { q: 'Run pii_inventory for security audit', intent: 'pii-inventory' },
      { q: 'Subgraph around AdvisorUserTableController', intent: 'subgraph' },
      {
        q: 'What Apex and flows does LWC demoApplicationWizard depend on?',
        intent: 'lwc-dependencies',
      },
      { q: 'Duplicate rules on Lead', intent: 'schema' },
      { q: 'Process builder migration candidates', intent: 'pb-wfr-migration' },
      { q: 'LWC bundles for application wizard', intent: 'lwc-dependencies' },
      {
        q: 'How many hed__Application__c with status Submitted?',
        intent: 'group-count',
      },
      { q: 'Live count of open Cases today', intent: 'record-count' },
      {
        q: 'demo_ApplicationWizardLwcController bootstrap path and callers',
        intent: 'call-graph',
      },
    ];
    for (const { q, intent } of cases) {
      const r = classifyQuestion(q);
      expect(r.intent, q).toBe(intent);
      expect(r.gap, q).toBeNull();
      expect(r.plane, q).not.toBe('unknown');
    }
  });

  it('routes realistic resolver, schema, permission, and report wording', () => {
    expect(
      classifyQuestion(
        'As a Salesforce admin, answer this with canonical IDs and provenance: Find or resolve Account [find-resolve 1]',
      ).plane,
    ).toBe('vault');
    expect(
      classifyQuestion(
        'As a Salesforce admin, answer this with canonical IDs and provenance: What metadata exists for Account? [schema 1]',
      ).intent,
    ).toBe('schema');
    expect(
      classifyQuestion(
        'Before a release, answer this with canonical IDs and provenance: Who can edit Contact Email? [permissions 2]',
      ).intent,
    ).toBe('field-access');
    expect(
      classifyQuestion(
        'During a production support review, answer this with canonical IDs and provenance: Which reports or dashboards cover Leads? [reports-dashboards 3]',
      ).plane,
    ).toBe('hybrid');
  });

  // QA-Bundle-2 (ROUTING): metadata / Apex / flow analysis questions were being
  // stolen by the broad live_* and inactive-* rules — `inactive-users` over-fires
  // on "user"/"license", `inactive-validation-rules` on "validation rule" — so
  // they misrouted to live_inactive_users / live_org_limits / live_stale_records
  // / governor_limit_risks / integration_map, none relevant. These assert the
  // new high-precision rules win, and the guard cases still route as before.
  it('routes a VR save-behavior question to what_happens_on_save + the rule formula, not live_inactive_users', () => {
    const cases = [
      'A validation rule whitelists save when $User.Profile is Admin. Does the save succeed for a Standard user?',
      'Does the validation rule allow the save to succeed if $Profile is System Administrator?',
      'For an inactive user, does the save succeed given the validation rule whitelist?',
    ];
    for (const q of cases) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('save-behavior');
      expect(r.tools).toContain('sfi.what_happens_on_save');
      expect(r.tools).toContain('sfi.get_component');
      expect(r.tools).not.toContain('sfi.live_inactive_users');
      expect(r.liveRequired).toBe(false);
    }
  });

  it('routes a flow-trigger + permission/license question to explain_flow, not live_inactive_users/license-usage', () => {
    const cases = [
      'When does the Application_Field_Sync_To_Contact flow fire, and what permission set or license lets it run?',
      'Which license lets a user run the Application_Field_Sync_To_Contact flow?',
    ];
    for (const q of cases) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('flow-trigger-context');
      expect(r.tools).toContain('sfi.explain_flow');
      expect(r.tools).not.toContain('sfi.live_inactive_users');
      expect(r.tools).not.toContain('sfi.live_license_usage');
      expect(r.needsResolve).toBe(true);
    }
  });

  it('routes a DLRS recursive-rollup question to automation/order-of-execution + the rollup lookup', () => {
    const cases = [
      'The CountCET3 DLRS rollup is recursive — how does the recursive trigger path work?',
      'How does the DLRS recursive rollup CountCET3 behave on save?',
      'When hed__Course_Enrollment__c is inserted, do dlrs_hed_Course_EnrollmentTrigger and CourseConnectionTrigger both fire?',
    ];
    for (const q of cases) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('dlrs-recursion');
      expect(r.tools).toContain('sfi.automation_risk_report');
      expect(r.tools).toContain('sfi.order_of_execution');
      expect(r.tools).toContain('sfi.search_components');
      expect(r.tools).not.toContain('sfi.governor_limit_risks');
      expect(r.tools).not.toContain('sfi.integration_map');
    }
  });

  it('does not let the new analysis rules steal genuine live login / license / VR-list questions', () => {
    expect(classifyQuestion('which users have not logged in for 90 days').intent).toBe(
      'inactive-users',
    );
    expect(classifyQuestion('how many licenses are unused').intent).toBe('license-usage');
    expect(classifyQuestion('list inactive validation rules').intent).toBe(
      'inactive-validation-rules',
    );
    expect(
      classifyQuestion('what does the AcmeCheck validation rule enforce').intent,
    ).toBe('explain-validation-rule');
  });

  it('routes ContactCategorySecurity family questions to validation-rule-family', () => {
    const q =
      'On Lead, the ContactCategorySecurity validation rule family protects SIS fields — which Contact_Security_Group__c values trigger protection (is value 3 editable or protected?) and which alias is exempt?';
    const r = classifyQuestion(q);
    expect(r.intent).toBe('validation-rule-family');
    expect(r.tools).toContain('sfi.list_components');
  });

  it('routes safe_to_delete_field tool phrasing to safe-to-delete', () => {
    const r = classifyQuestion(
      'safe_to_delete_field Contact.Email — does it correctly call a standard field undeletable?',
    );
    expect(r.intent).toBe('safe-to-delete');
    expect(r.tools).toContain('sfi.safe_to_delete_field');
  });

  it('routes named-credential orphan questions to component-usage with find_component_usages', () => {
    const q =
      'Named credential AWS_US_East_1 (NoAuth, ARN endpoint) — is it referenced by any Apex or Flow, or orphaned with zero references?';
    const r = classifyQuestion(q);
    expect(r.intent).toBe('component-usage');
    expect(r.tools).toContain('sfi.find_component_usages');
    expect(r.suggestedArgs).toEqual({ componentId: 'NamedCredential:AWS_US_East_1' });
  });

  it('routes only to real tool names (sfi.*)', () => {
    for (const c of CASES) {
      for (const t of classifyQuestion(c.q).tools) {
        expect(t).toMatch(/^sfi\.[a-z0-9_]+$/);
      }
    }
  });
});

describe('router ↔ roster contract (CI gate)', () => {
  it('every tool the router can emit is a real registered V01 tool', () => {
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    const missing = allRoutableTools().filter((t) => !registered.has(t));
    expect(missing).toEqual([]);
  });

  it('exposes a broad slice of the surface (>= 40 distinct tools)', () => {
    expect(allRoutableTools().length).toBeGreaterThanOrEqual(40);
  });

  // P12-ROUTER-intent-coverage (the "a tool ships without a router entry FAILS"
  // half — subsumes the legacy product-surface-gate). Every V01 tool must be
  // reachable from `route_question` OR be on this grandfathered allowlist of
  // tools that are intentionally NOT router-primary: meta/front-door tools, the
  // opt-in live-plane helpers the agent calls directly, and sub-tools reached
  // via a bundle/`resolve` rather than their own intent. A NEW tool that is
  // neither routable nor grandfathered fails here — which is exactly the gap
  // that left the 11 Phase-11 access/UI tools unrouted until P12.
  const GRANDFATHERED_NON_ROUTABLE = new Set<string>([
    // Meta / front-door / plumbing (never a question's primary answer):
    'sfi.route_question', 'sfi.synthesize_answer',
    'sfi.get_manifest', 'sfi.export_manifest', 'sfi.baseline_acknowledge',
    'sfi.baseline_status', 'sfi.live_consent', 'sfi.live_budget',
    // P13-GW catalog gateway (meta-navigation; P13-GW-router-envelope wires
    // route_question to EMIT run_analysis envelopes under the core profile —
    // the gateway tools themselves are never a question's primary answer):
    'sfi.list_analyses', 'sfi.describe_analysis', 'sfi.run_analysis',
    // P13-ANNOT-tools — `propose_annotation` is agent plumbing, never a
    // question's primary answer. sfi.annotations is now router-reachable
    // ("who owns X" — P14-ROUTER-goldset-expand).
    'sfi.propose_annotation',
    // P13-GITHIST-tools — `component_as_of` is a drill reached AFTER a
    // component is in hand; sfi.component_history is now router-reachable
    // ("when did X change" — P14-ROUTER-goldset-expand).
    'sfi.component_as_of',
    // Opt-in live-plane helpers the agent invokes directly inside a live flow.
    // sfi.live_automation_fired ("did the flow fire yesterday") and
    // sfi.live_picklist_usage ("which values are never used") are now
    // router-reachable (router-v2 P4 needs-live reachability).
    'sfi.blast_radius_live', 'sfi.live_describe', 'sfi.live_stale_check',
    // Sub-tools / specialized drills reached via a bundle or after `resolve`:
    'sfi.decision_table_browse',
    // sfi.explain_formula is now router-reachable (QA-Bundle-2 save-behavior rule).
    'sfi.field_meaning',
    // sfi.find_semantic_field is now router-reachable (USAGE/FIELD-FORENSICS
    // REACH — the find-semantic-field intent: "do we have a field for X" /
    // "where do we store <concept> data across the org").
    'sfi.fleet_find',
    // sfi.layout_assignments is now router-reachable (P12-ROUTER-layout-assignments).
    // sfi.lookup_record is now router-reachable (P14-ROUTER-cmdt-record-values).
    'sfi.org_pulse',
    'sfi.promotion_readiness', 'sfi.test_coverage_for_method',
    // sfi.profile_security is now router-reachable (eval family C — the
    // profile-security intent: IP relaxation / login IP / login hours), and
    // sfi.what_if_disable_trigger is now router-reachable (eval family C —
    // "blast radius if I disable trigger T").
    // sfi.what_if_change_method_signature is now router-reachable
    // (P14-ROUTER-method-signature-impact); sfi.what_changed_since_refresh
    // is now router-reachable (P14-ROUTER-stress-20).
    // sfi.what_if_deactivate_flow is now router-reachable (RESIDUAL 2 —
    // "what breaks if I deactivate the X flow" / "turn off FlowA and FlowB").
    'sfi.what_if_split_profile',
  ]);

  it('every V01 tool is router-reachable OR explicitly grandfathered (no silently-unrouted tool)', () => {
    const routable = new Set(allRoutableTools());
    const orphans = V01_TOOLS.map((t) => t.name).filter(
      (name) => !routable.has(name) && !GRANDFATHERED_NON_ROUTABLE.has(name),
    );
    expect(orphans).toEqual([]);
  });

  it('the grandfather list has no stale entries (a now-routable tool must be removed from it)', () => {
    const routable = new Set(allRoutableTools());
    const stale = [...GRANDFATHERED_NON_ROUTABLE].filter((name) => routable.has(name));
    expect(stale).toEqual([]);
  });
});

// Baseline-300 route-gap cluster — each was `unrouted` before P14 router-residuals batch.
describe('baseline-300 route-gap clusters', () => {
  const expectRouted = (q: string, intent: string) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe(intent);
    expect(r.intent).not.toBe('unrouted');
  };

  it('UI / LWC / Aura / VF inventory', () => {
    expectRouted('What Lightning Web Components exist in this org?', 'schema');
    expectRouted('Which LWCs use the Lightning Data Service?', 'lwc-dependencies');
    expectRouted('What Visualforce pages exist?', 'schema');
  });

  it('automation strategy / legacy / overlap', () => {
    expectRouted('Are there overlapping automations on the Lead object that might conflict?', 'automation-risk');
    expectRouted('What percentage of automation is in legacy tools versus Flow?', 'automation-risk');
    expectRouted('Which flows send emails?', 'flow-search');
  });

  it('Apex explain / triggers / tests', () => {
    expectRouted('What does the OpportunityTrigger do?', 'explain-apex');
    expectRouted('Which objects have more than one trigger?', 'trigger-quality');
    expectRouted('Which Apex classes have less than 75% code coverage?', 'test-coverage');
    expectRouted('What test classes exist in this org?', 'test-coverage');
  });

  it('security / access / layout reverse lookups', () => {
    expectRouted('Which profiles can run reports?', 'user-ability');
    expectRouted('Which record type uses the Enterprise Account Layout?', 'layout-assignments');
    expectRouted('Which users have admin-level access?', 'over-permission');
  });

  it('org health / architect synthesis', () => {
    expectRouted('What is the overall health of this org?', 'tech-debt');
    expectRouted('What are the top risks in the current implementation?', 'tech-debt');
  });
});

// RESIDUAL 2 — the disable / deactivate / turn-off what-if family. The verb
// (disable/deactivate/turn off) + the resolved component TYPE picks the tool:
// Trigger -> what_if_disable_trigger, Flow -> what_if_deactivate_flow, and a
// permission set (which has NO what_if simulator) routes honestly to
// permission_risk_report. Plain save-order questions must stay on trigger-order.
describe('RESIDUAL 2 — disable / deactivate / turn-off what-if routing', () => {
  const routes = (q: string, intent: string, primaryTool: string) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe(intent);
    expect(r.plane).toBe('vault');
    expect(r.tools).toContain(primaryTool);
  };

  it('routes a "blast radius if I disable the <Trigger> trigger" ask to what_if_disable_trigger', () => {
    routes(
      'blast-radius report if I disable the OrderSyncTrigger trigger',
      'what-if-disable-trigger',
      'sfi.what_if_disable_trigger',
    );
  });

  it('routes "what breaks if I deactivate the <Flow> flow" to what_if_deactivate_flow', () => {
    routes(
      'what breaks if I deactivate the Onboarding_Flow flow',
      'what-if-deactivate-flow',
      'sfi.what_if_deactivate_flow',
    );
  });

  it('routes "if I turn off <FlowA> and <FlowB>, does anything break" to what_if_deactivate_flow', () => {
    routes(
      'if I turn off Discount_Flow and Pricing_Flow, does anything break',
      'what-if-deactivate-flow',
      'sfi.what_if_deactivate_flow',
    );
  });

  it('routes "if we deactivate the <X> permission set, does anything break" honestly to permission_risk_report', () => {
    // No what_if exists for permission sets, so the honest target is the risk
    // report (what it grants + who depends on it), never an invented simulator.
    routes(
      'if we deactivate the Sales_Access permission set, does anything break',
      'permission-set-deactivation-impact',
      'sfi.permission_risk_report',
    );
  });

  it('does NOT swallow a plain save-order question (regression guard)', () => {
    // "what runs when X is saved" carries no disable/deactivate verb, so it
    // stays on trigger-order — the deactivate family must not steal it.
    expect(classifyQuestion('what runs when a Contact is saved').intent).toBe('trigger-order');
    expect(classifyQuestion('what happens when I update an Account').intent).toBe('trigger-order');
  });

  it('does NOT reclassify a deactivate ask on a *plural* embedded-Flow name away from impact-analysis', () => {
    // "ADA_Accom_Flow_Attribute_Flows" embeds "Flow" but has no standalone
    // "flow" word and no trailing _Flow token, so it stays impact-analysis.
    expect(
      classifyQuestion('What if we deactivate ADA_Accom_Flow_Attribute_Flows?').intent,
    ).toBe('impact-analysis');
  });
});

describe('enterprise route metadata', () => {
  it('classifies route risk and exposes competing intents (P4: complementary pair STACKS, no block)', () => {
    const r = classifyQuestion('What breaks if I delete the Account field?');
    expect(r.risk).not.toBe('informational');
    expect(r.alternatives.length).toBeGreaterThan(0);
    // Router-v2 P4: impact-analysis|safe-to-delete is a COMPLEMENTARY pair —
    // either read answers, so the alternative's tools stack after the primary
    // and execution is not blocked on a which-first round-trip.
    expect(r.confidence).toBe('medium');
    expect(r.clarification).toBeNull();
    expect(r.tools).toContain('sfi.safe_to_delete_field');
    expect(r.reason).toContain('complementary');
  });

  it('generic object access runs BOTH lenses (P4: record visibility + CRUD stack, no block)', () => {
    const r = classifyQuestion('Who can access Account?');
    expect(r.intent).toBe('who-can-access-object');
    expect(r.risk).toBe('security-sensitive');
    expect(r.alternatives.map((alternative) => alternative.intent)).toContain('object-access');
    // Router-v2 P4: who-can-access-object|object-access is complementary —
    // the grantor enumeration and the CRUD matrix both answer, stacked.
    expect(r.clarification).toBeNull();
    expect(r.tools).toContain('sfi.who_can_access_object');
    expect(r.tools).toContain('sfi.object_access_audit');
  });

  it('stops when who-changed wording does not distinguish records from metadata', () => {
    const r = classifyQuestion('Who changed Account?');
    expect(r.intent).toBe('runtime-audit-trail');
    expect(r.alternatives.map((alternative) => alternative.intent)).toContain('last-modified');
    expect(r.clarification?.required).toBe(true);
    expect(r.clarification?.question).toContain('runtime record/audit trail');
    expect(r.clarification?.question).toContain('metadata component last-modified information');
  });

  it('does not stop an explicit record audit-trail question', () => {
    const r = classifyQuestion('Who changed this Account record?');
    expect(r.intent).toBe('runtime-audit-trail');
    expect(r.alternatives).toEqual([]);
    expect(r.clarification).toBeNull();
  });

  it('keeps a single-intent informational route high confidence', () => {
    const r = classifyQuestion('Show me the org card');
    expect(r.risk).toBe('informational');
    expect(r.confidence).toBe('high');
    expect(r.clarification).toBeNull();
  });

  it.each([
    'find dead code',
    'what flows run on Account when updated',
    'what fields contain PII',
    'what flows can the guest user run',
    'who is this list view shared with',
    'what changed since the last refresh',
    'what references Account.Industry in formulas or validation rules',
    'what breaks if I change the signature of a method in OpportunityService',
    'who can access every Account record',
  ])('does not expose harmless regex overlap as ambiguity: %s', (question) => {
    const r = classifyQuestion(question);
    expect(r.alternatives).toEqual([]);
    expect(r.clarification).toBeNull();
    expect(r.confidence).toBe('high');
  });
});

describe('gap log', () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-gap-'));
    logPath = join(dir, 'question-gaps.jsonl');
    process.env.SFI_GAP_LOG_PATH = logPath;
  });
  afterEach(() => {
    delete process.env.SFI_GAP_LOG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors SFI_GAP_LOG_PATH', () => {
    expect(gapLogPath()).toBe(logPath);
  });

  it('stamps the entry with the vault root when provided (P14-FEEDBACK-gaplog-scope)', async () => {
    const route = classifyQuestion('completely unanswerable gibberish zzz qqq');
    expect(route.gap).not.toBeNull();
    const entry = await logGapIfAny(route, logPath, '/work/a/org-kb');
    expect(entry?.vaultRoot).toBe('/work/a/org-kb');
    const written = JSON.parse(readFileSync(logPath, 'utf8').trim()) as { vaultRoot?: string };
    expect(written.vaultRoot).toBe('/work/a/org-kb');
  });

  it('omits the vaultRoot key entirely when none is provided (legacy shape preserved)', async () => {
    const route = classifyQuestion('completely unanswerable gibberish zzz qqq');
    const entry = await logGapIfAny(route, logPath);
    expect(entry).not.toBeNull();
    expect('vaultRoot' in (entry ?? {})).toBe(false);
  });

  it('writes nothing for a routed live catalog question', async () => {
    const route = classifyQuestion('how many reports are useless?');
    const entry = await logGapIfAny(route);
    expect(entry).toBeNull();
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('writes nothing for a clean route', async () => {
    const entry = await logGapIfAny(classifyQuestion('what custom objects do we have?'));
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Eval Family D — wrong-plane routes / missing candidates. Each phrasing family
// previously routed to a tool that does not carry the data (schema/get_component
// for coverage asks, grant-describing tools for holder rosters) or fell to
// `unrouted` when a real tool existed.
// ---------------------------------------------------------------------------
describe('Family D — wrong-plane / missing-candidate routes', () => {
  it('apex coverage asks route to the coverage tools, never the schema catalog', () => {
    for (const q of [
      'list apex classes below 75% coverage',
      'which classes are untested',
      'Which Apex classes have less than 75% code coverage?',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('test-coverage');
      expect(r.tools).toContain('sfi.apex_test_coverage');
      expect(r.tools).toContain('sfi.test_coverage_gaps');
      expect(r.tools).not.toContain('sfi.get_component');
      expect(r.tools).not.toContain('sfi.list_components');
    }
  });

  it('API-version asks route to tech_debt_score (apexBelowApiVersion50Count) + list_components', () => {
    for (const q of [
      'any apex still on API version below 50?',
      'is any apex still on an old api version',
      'which classes need their api version bumped',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('api-version-audit');
      expect(r.plane).toBe('vault');
      expect(r.tools).toEqual(['sfi.tech_debt_score', 'sfi.list_components']);
      expect(r.suggestedArgs).toEqual({ type: 'ApexClass' });
    }
  });

  it('the single-component "what is the api version of X" lookup stays on schema', () => {
    const r = classifyQuestion('What is the API version of the AccountService class?');
    expect(r.intent).toBe('schema');
  });

  it('empty-object asks route to the live plane (live_storage_by_object)', () => {
    for (const q of [
      'which custom objects are essentially empty in prod',
      'what objects are basically empty',
      'objects with zero records',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('storage-by-object');
      expect(r.plane).toBe('live');
      expect(r.tools).toEqual(['sfi.live_storage_by_object']);
    }
  });

  it('empty FIELDS stay on field-population; empty QUEUES stay on the vault membership scan', () => {
    expect(classifyQuestion('Which Account fields are empty?').intent).toBe('field-population');
    expect(classifyQuestion('Are there empty queues or groups?').intent).toBe('empty-queues-groups');
  });

  it('profile user-roster asks route LIVE (User records) with a partial-answer disclosure', () => {
    for (const q of [
      'list everyone with the Regional Sales profile',
      'which users have the Support Agent profile',
      'who has the Regional Sales profile',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('profile-user-roster');
      expect(r.plane).toBe('live');
      expect(r.liveRequired).toBe(true);
      expect(r.tools).toContain('sfi.live_group_count');
      // Never the Profile METADATA catalog, never a grant-describing tool.
      expect(r.tools).not.toContain('sfi.get_component');
      expect(r.tools).not.toContain('sfi.effective_permissions');
      expect(r.suggestedArgs).toEqual({ objectApiName: 'User', groupByField: 'ProfileId' });
      expect(r.gap?.category).toBe('profile-user-roster');
    }
  });

  it('"how many users on profile X" keeps the dedicated live count intent (no roster steal)', () => {
    expect(classifyQuestion('How many users are on the System Administrator profile?').intent)
      .toBe('profile-assignment-count');
    expect(classifyQuestion('How many users are assigned to the System Administrator profile?').intent)
      .toBe('profile-assignment-count');
  });

  it('permission-set HOLDER rosters are an honest gap — PermissionSetAssignment is not modeled', () => {
    for (const q of [
      'which users have permission set Data Export',
      'who has the Data Export permission set assigned',
      'list users with the Data Export permission set',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('permset-user-roster');
      // No tools: routing to effective_permissions / object_access_audit would
      // describe what the permission set GRANTS, not who HOLDS it.
      expect(r.tools).toHaveLength(0);
      expect(r.gap?.category).toBe('permset-user-roster');
      expect(r.gap?.note).toMatch(/PermissionSetAssignment/);
    }
  });

  it('the reverse "what permission sets does a user have" keeps effective-permissions', () => {
    expect(classifyQuestion('What permission sets are assigned to that user?').intent)
      .toBe('effective-permissions');
  });

  it('admin-level access sweeps keep over-permission (no roster steal)', () => {
    expect(classifyQuestion('Which users have admin-level access?').intent).toBe('over-permission');
  });

  it('cross-vault compare routes carry the second-registered-vault disclosure, NOT a block', () => {
    for (const q of [
      'compare this org against production',
      'compare the Account object across our sandboxes',
      "What's different between UAT and prod?",
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('cross-org-diff');
      // Disclosure rides on the route; the tools stay executable (not a hard block).
      expect(r.tools).toContain('sfi.compare_vaults');
      expect(r.gap?.category).toBe('cross-vault-registry');
      expect(r.gap?.note).toMatch(/second registered vault/i);
      expect(r.clarification).toBeNull();
    }
  });

  it('the generic profile-vs-permission-set compare is untouched by the cross-vault patterns', () => {
    expect(classifyQuestion('difference between a profile and a permission set').intent)
      .toBe('compare-profiles');
  });
});

// ---------------------------------------------------------------------------
// Eval Family B — tool ↔ component-type guard. When the question's entity
// RESOLVES to a Flow, the route must never ship Apex-only tools (call_graph /
// method_reachability / explain_apex_method) or object/field-only access
// audits — those hard-error on a Flow id. The guard SUBSTITUTES the Flow-
// appropriate tools (who_can_run / explain_flow / get_impact) instead.
// ---------------------------------------------------------------------------
describe('Family B — resolved-type guard (pure)', () => {
  it('swaps the Apex call-graph tools for explain_flow + get_impact on a Flow', () => {
    const route = classifyQuestion('who calls the Order Fulfillment logic');
    expect(route.intent).toBe('call-graph');
    const guarded = applyComponentTypeGuard(route, 'Flow');
    expect(guarded.tools).toEqual(['sfi.resolve', 'sfi.explain_flow', 'sfi.get_impact']);
    expect(guarded.tools).not.toContain('sfi.call_graph');
    expect(guarded.tools).not.toContain('sfi.method_reachability');
    // The plan step mirrors the substituted tools.
    expect(guarded.plan[0]?.tools).toEqual(guarded.tools);
  });

  it('swaps access-audit tools for who_can_run + explain_flow on a Flow (access-flavored)', () => {
    const route = classifyQuestion('who has access to edit the Order Fulfillment flow?');
    const guarded = applyComponentTypeGuard(route, 'Flow');
    expect(guarded.tools).toContain('sfi.who_can_run');
    expect(guarded.tools).toContain('sfi.explain_flow');
    expect(guarded.tools).not.toContain('sfi.field_access_audit');
    expect(guarded.tools).not.toContain('sfi.who_can_access_object');
    // who_can_run leads (after the resolve preamble) for an access ask.
    expect(guarded.tools[0]).toBe('sfi.resolve');
    expect(guarded.tools[1]).toBe('sfi.who_can_run');
  });

  it('guards who_can_access_object itself when its entity is a Flow', () => {
    const route = classifyQuestion('Show me every profile that can access Case');
    expect(route.tools).toContain('sfi.who_can_access_object');
    const guarded = applyComponentTypeGuard(route, 'Flow');
    expect(guarded.tools).not.toContain('sfi.who_can_access_object');
    expect(guarded.tools).toContain('sfi.who_can_run');
    expect(guarded.tools).toContain('sfi.explain_flow');
  });

  it('is a no-op for an ApexClass resolution, a null resolution, and a Flow-compatible route', () => {
    const callGraph = classifyQuestion('who calls the PaymentProcessor class');
    expect(applyComponentTypeGuard(callGraph, 'ApexClass')).toBe(callGraph);
    expect(applyComponentTypeGuard(callGraph, null)).toBe(callGraph);
    const explainFlow = classifyQuestion('explain the Order Fulfillment flow');
    expect(applyComponentTypeGuard(explainFlow, 'Flow')).toBe(explainFlow);
  });

  it('resolvedTypeForGuard: exact trusts the top; ambiguous types only when no candidate fits the guarded tools', () => {
    const route = classifyQuestion('who calls the Order Fulfillment logic');
    const candidate = (id: string, type: ComponentType) => ({
      id: id as ComponentId, type, apiName: id.slice(id.indexOf(':') + 1), label: null,
      parentApiName: null, score: 0.9, base: 0.9,
      matchKind: 'fuzzy' as const, evidence: 'test',
    });
    // exact → the top candidate's type, whatever it is.
    expect(
      resolvedTypeForGuard(route, {
        disposition: 'exact',
        candidates: [candidate('Flow:Order_Fulfillment', 'Flow')],
      }),
    ).toBe('Flow');
    // ambiguous, Flow top, rivals are the flow's own contexts — NONE could
    // satisfy call_graph/method_reachability, so substitution is safe.
    expect(
      resolvedTypeForGuard(route, {
        disposition: 'ambiguous',
        candidates: [
          candidate('Flow:Order_Fulfillment', 'Flow'),
          candidate('ConditionalContext:Flow:Order_Fulfillment.condition-0', 'ConditionalContext'),
        ],
      }),
    ).toBe('Flow');
    // ambiguous with an APEX rival — the route may be right once the user
    // picks, so stay untyped (no substitution before the menu resolves).
    expect(
      resolvedTypeForGuard(route, {
        disposition: 'ambiguous',
        candidates: [
          candidate('Flow:Order_Fulfillment', 'Flow'),
          candidate('ApexClass:OrderFulfillmentService', 'ApexClass'),
        ],
      }),
    ).toBeNull();
    // none / empty → untyped.
    expect(resolvedTypeForGuard(route, { disposition: 'none', candidates: [] })).toBeNull();
    expect(resolvedTypeForGuard(route, null)).toBeNull();
  });
});

// --- Family B wired end to end over a fixture vault -------------------------
const TYPE_GUARD_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-30T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:type-guard-fixture',
};
const typeGuardNode = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const TYPE_GUARD_SEED: ExtractionResult = {
  nodes: [
    typeGuardNode({
      id: 'Flow:Order_Fulfillment',
      apiName: 'Order_Fulfillment',
      label: 'Order Fulfillment',
      type: 'Flow',
    }),
    typeGuardNode({
      id: 'ApexClass:PaymentProcessor',
      apiName: 'PaymentProcessor',
      label: 'PaymentProcessor',
      type: 'ApexClass',
    }),
  ],
  edges: [],
};

describe('Family B — routeQuestionHandler substitutes on a real Flow resolution', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-type-guard-'));
    const opened = await openGraph(join(dir, 'type-guard.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imported = await importExtractionResults(store, [TYPE_GUARD_SEED]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx = { vaultRoot: dir, manifest: TYPE_GUARD_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('"who calls the <FlowName> logic" ships explain_flow, never the Apex call graph', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'who calls the Order Fulfillment logic' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, toolCandidates, executionBlocked, entityEvidence } = r.value.data;
    expect(executionBlocked).toBe(false);
    expect(entityEvidence?.candidates[0]?.type).toBe('Flow');
    expect(route.tools).toContain('sfi.explain_flow');
    expect(route.tools).toContain('sfi.get_impact');
    expect(route.tools).not.toContain('sfi.call_graph');
    expect(route.tools).not.toContain('sfi.method_reachability');
    // The substitutes surface in the funnel shortlist too.
    expect(toolCandidates?.map((c) => c.tool)).toContain('sfi.explain_flow');
  });

  it('"call graph for whatever apex the <FlowName> flow invokes" leads with explain_flow', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'call graph for whatever apex the Order Fulfillment flow invokes',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, executionBlocked } = r.value.data;
    expect(executionBlocked).toBe(false);
    const answering = route.tools.filter((t) => t !== 'sfi.resolve');
    expect(answering[0]).toBe('sfi.explain_flow');
    expect(route.tools).not.toContain('sfi.call_graph');
    expect(route.tools).not.toContain('sfi.method_reachability');
  });

  it('"who has access to edit the <FlowName>?" routes to who_can_run + explain_flow, never an object/field audit', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who has access to edit the Order Fulfillment flow?',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, executionBlocked } = r.value.data;
    expect(executionBlocked).toBe(false);
    expect(route.tools).toContain('sfi.who_can_run');
    expect(route.tools).toContain('sfi.explain_flow');
    expect(route.tools).not.toContain('sfi.who_can_access_object');
    expect(route.tools).not.toContain('sfi.field_access_audit');
  });

  it('an Apex resolution keeps the Apex call-graph tools (guard is type-scoped, not blanket)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'who calls the PaymentProcessor class' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route } = r.value.data;
    expect(route.tools).toContain('sfi.call_graph');
    expect(route.tools).not.toContain('sfi.explain_flow');
  });
});

// ---------------------------------------------------------------------------
// Eval Family C — QUALIFIER HIJACK. One modifier word ("bulk", "seats",
// "integration", "compliance", "async") was dragging the route away from the
// head-noun intent onto governor_limit_risks / live_license_usage /
// integration_map / live_report_usage / generic guidance. The head question
// must win; the modifier bucket keeps only questions where it IS the head.
// ---------------------------------------------------------------------------
describe('Family C — qualifier words never outrank the head-noun intent', () => {
  it('"bulk"/"load" does not force governor-risks off a save-order head', () => {
    const r = classifyQuestion(
      'What fires on Shipment__c insert during the integration load — what runs bulk?',
    );
    expect(r.intent).toBe('trigger-order');
    expect(r.tools).toContain('sfi.what_happens_on_save');
    expect(r.tools).toContain('sfi.order_of_execution');
    expect(r.tools).not.toContain('sfi.governor_limit_risks');
    expect(r.tools).not.toContain('sfi.integration_map');
  });

  it('"bulk" does not force governor-risks off a which-test-covers head', () => {
    const r = classifyQuestion(
      'Which test class covers ShipmentProcessor and does it test the bulk case?',
    );
    expect(r.intent).toBe('tests-for-change');
    expect(r.tools).toContain('sfi.tests_for_change');
    expect(r.tools).not.toContain('sfi.governor_limit_risks');
  });

  it('genuine bulk/governor asks keep governor-risks (the modifier bucket still owns its head)', () => {
    expect(classifyQuestion('are there unbounded SOQL queries in our apex?').intent)
      .toBe('governor-risks');
    expect(classifyQuestion('Find SOQL in loops').intent).toBe('governor-risks');
  });

  it('"seats" does not drag a permission-set-assignment ask onto the live license counter', () => {
    const r = classifyQuestion(
      'Who is assigned the Data Export permission set — are we wasting seats?',
    );
    expect(r.intent).toBe('permset-user-roster');
    expect(r.gap?.category).toBe('permset-user-roster');
    expect(r.tools).not.toContain('sfi.live_license_usage');
    expect(r.tools).not.toContain('sfi.live_inactive_users');
    // Genuine license-usage asks keep the live counter.
    expect(classifyQuestion('how many licenses are unused').intent).toBe('license-usage');
    expect(classifyQuestion('how many permission set licenses are assigned?').intent)
      .toBe('license-usage');
  });

  it('"integration user" does not force integration_map off a field-write audit', () => {
    const r = classifyQuestion('Which fields are only ever written by an integration user?');
    expect(r.intent).toBe('field-access');
    expect(r.tools).toContain('sfi.field_access_audit');
    expect(r.tools).not.toContain('sfi.integration_map');
  });

  it('"integration users" does not force integration_map off a profile IP-security ask', () => {
    const r = classifyQuestion(
      'Do any profiles have IP relaxation that would block integration users?',
    );
    expect(r.intent).toBe('profile-security');
    expect(r.tools).toContain('sfi.profile_security');
    expect(r.tools).toContain('sfi.list_components');
    expect(r.suggestedArgs).toEqual({ type: 'Profile' });
    expect(r.tools).not.toContain('sfi.integration_map');
  });

  it('"blast radius if I disable trigger T" routes to the disable-trigger what-if', () => {
    for (const q of [
      "What's the blast radius if I disable the OrderSync trigger?",
      'What breaks downstream if we disable the OrderSync trigger?',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('what-if-disable-trigger');
      expect(r.tools).toContain('sfi.what_if_disable_trigger');
      expect(r.tools).not.toContain('sfi.integration_map');
      expect(r.tools).not.toContain('sfi.field_lineage');
      expect(r.risk).toBe('destructive');
    }
  });

  it('"what integrations blow up if the field type changed" routes to the field-type what-if', () => {
    const r = classifyQuestion(
      'If the field type changed on Shipment_Weight__c, what integrations blow up?',
    );
    expect(r.intent).toBe('what-if-field');
    expect(r.tools).toContain('sfi.what_if_change_field_type');
    expect(r.tools).not.toContain('sfi.integration_map');
    // The genuine topology catalog is untouched.
    expect(classifyQuestion('What integrations and named credentials do we have?').intent)
      .toBe('integration-map');
  });

  it('"compliance report … who touches <field>" is a field-access audit, not report usage', () => {
    const r = classifyQuestion(
      'Generate a compliance report of who touches the Taxpayer_Id__c field.',
    );
    expect(r.intent).toBe('field-access');
    expect(r.tools).toContain('sfi.field_access_audit');
    expect(r.tools).not.toContain('sfi.live_report_usage');
    // Genuine report-staleness asks keep the hybrid usage route.
    expect(classifyQuestion('How many reports in the system are useless?').intent)
      .toBe('reports-usage');
  });

  it('"async … in its own transaction" about a named component reads the component, not guidance', () => {
    const r = classifyQuestion(
      'Does the NightlyInvoiceSync job run async in its own transaction?',
    );
    expect(r.intent).toBe('async-transaction-context');
    expect(r.plane).toBe('vault');
    expect(r.tools).toEqual(['sfi.resolve', 'sfi.get_component']);
    expect(r.tools).not.toContain('sfi.guidance');
    // Generic async-strategy asks (no own-transaction frame) keep the knowledge plane.
    expect(classifyQuestion('future vs queueable vs batch — which to use when?').intent)
      .toBe('guidance');
  });

  it('"HTTP callouts and endpoints" greps Apex source, not the outbound catalog or lineage', () => {
    const r = classifyQuestion('Which classes make HTTP callouts and what endpoints do they hit?');
    expect(r.intent).toBe('apex-search');
    expect(r.tools).toContain('sfi.search_apex_source');
    expect(r.tools).not.toContain('sfi.field_lineage');
    // The outbound catalog keeps its own head ("what endpoints do we call out to").
    expect(classifyQuestion('What endpoints do we call out to?').intent).toBe('endpoints');
  });
});

// ---------------------------------------------------------------------------
// Eval Family E (1) — field_lineage demoted from catch-all. pii-flow keeps
// only explicit lineage/provenance/movement frames; field-adjacent questions
// with a change/impact head route on their own intents.
// ---------------------------------------------------------------------------
describe('Family E — field_lineage is never the field-adjacent default', () => {
  it('a delete-impact question with "downstream" in it stays impact-analysis', () => {
    const r = classifyQuestion(
      'What breaks downstream if I delete the Shipment_Weight__c field?',
    );
    expect(r.intent).toBe('impact-analysis');
    expect(r.tools).not.toContain('sfi.field_lineage');
  });

  it('"downstream effects of changing X" routes to the dedicated downstream_effects tool', () => {
    const r = classifyQuestion('downstream effects of changing the OrderTotals class');
    expect(r.intent).toBe('downstream-effects');
    expect(r.tools).toContain('sfi.downstream_effects');
  });

  it('explicit lineage/provenance frames keep pii-flow (field_lineage)', () => {
    for (const q of [
      'Where does the SSN field flow downstream?',
      'where does the data in Taxpayer_Id__c come from?',
      'show the lineage of Contact fields',
    ]) {
      const r = classifyQuestion(q);
      expect(r.intent).toBe('pii-flow');
      expect(r.tools).toContain('sfi.field_lineage');
    }
  });
});

// ---------------------------------------------------------------------------
// Eval lifecycle family — adverb-tolerant and nominalized conversion phrasings.
// The DML-event save-order rule stays disjoint: no transition verb appears in
// its patterns, and no DML event appears in these.
// ---------------------------------------------------------------------------
describe('lifecycle-transition phrasings (adverbs + nominalization)', () => {
  it.each([
    'What runs automatically when a Lead is converted?',
    'What runs in the background when a Lead is converted?',
    'What runs on Lead conversion?',
    'what fires upon a Lead conversion',
  ])('routes "%s" to lifecycle-process', (q) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe('lifecycle-process');
    expect(r.tools).toContain('sfi.lifecycle_process');
  });

  it('keeps the DML save-order rule disjoint (insert stays trigger-order)', () => {
    expect(classifyQuestion('What runs on Account insert?').intent).toBe('trigger-order');
    expect(classifyQuestion('what runs when a Lead is converted').intent).toBe('lifecycle-process');
  });
});

// ---------------------------------------------------------------------------
// Eval Family E (2) — FALSE PREMISE, wired end to end over a fixture vault.
// A question that NAMES a component the resolver cannot find must not present
// as clean + high-confidence: confidence is downgraded and entityEvidence
// carries the premise disclosure — but the route still ships (the routed tool
// fails closed on the unknown id; execution is never blocked here).
// ---------------------------------------------------------------------------
describe('Family E — false-premise (resolver none) disclosure', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  // TYPE_GUARD_SEED plus a Case object with two similar fields, so a typo'd
  // LITERAL field reference resolves to fuzzy lookalikes (the ambiguous form
  // of a false premise a large vault produces) rather than a bare `none`.
  const FALSE_PREMISE_SEED: ExtractionResult = {
    nodes: [
      ...TYPE_GUARD_SEED.nodes,
      typeGuardNode({ id: 'CustomObject:Case', apiName: 'Case', label: 'Case' }),
      typeGuardNode({
        id: 'CustomField:Case.Shipping_Total__c',
        apiName: 'Shipping_Total__c',
        label: 'Shipping Total',
        type: 'CustomField',
        parentId: 'CustomObject:Case',
      }),
      typeGuardNode({
        id: 'CustomField:Case.Shipment_Total__c',
        apiName: 'Shipment_Total__c',
        label: 'Shipment Total',
        type: 'CustomField',
        parentId: 'CustomObject:Case',
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-false-premise-'));
    const opened = await openGraph(join(dir, 'false-premise.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imported = await importExtractionResults(store, [FALSE_PREMISE_SEED]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx = { vaultRoot: dir, manifest: TYPE_GUARD_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('downgrades confidence and attaches the premise disclosure when the named entity resolves to none', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'who calls the GhostService class' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence, executionBlocked } = r.value.data;
    // Still routed to the fail-closed tool — never blocked.
    expect(executionBlocked).toBe(false);
    expect(route.tools).toContain('sfi.call_graph');
    // But never clean + high-confidence.
    expect(route.confidence).toBe('low');
    expect(route.reason).toContain('PREMISE CHECK');
    expect(entityEvidence?.disposition).toBe('none');
    expect(entityEvidence?.candidates).toEqual([]);
    expect(entityEvidence?.clarificationRequired).toBe(false);
    expect(entityEvidence?.warning).toMatch(/no component matching '.+' exists in the vault/);
  });

  it('a typo\'d LITERAL field reference gets the premise disclosure even when fuzzy lookalikes exist', async () => {
    // Neither Shipping_Total__c nor Shipment_Total__c is what was named — a
    // literal __c reference is an unambiguous NAME, so lookalikes must not
    // present as a routine weak-match warning (large vaults rarely return
    // a bare `none`; this is the false-premise shape they actually produce).
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit Shipmentt_Total__c on Case?',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence, executionBlocked } = r.value.data;
    expect(executionBlocked).toBe(false);
    expect(route.confidence).toBe('low');
    expect(route.reason).toContain('PREMISE CHECK');
    expect(entityEvidence?.warning).toMatch(/PREMISE CHECK/);
  });

  it('an entity that DOES resolve keeps a clean high-confidence route (no premise noise)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'who calls the PaymentProcessor class' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence } = r.value.data;
    expect(entityEvidence?.disposition).toBe('exact');
    expect(route.confidence).toBe('high');
    expect(route.reason).not.toContain('PREMISE CHECK');
  });

  it('a correctly named LITERAL field keeps its clean route (no premise flag)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit Shipment_Total__c on Case?',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence } = r.value.data;
    expect(entityEvidence?.disposition).toBe('exact');
    expect(route.reason).not.toContain('PREMISE CHECK');
  });
});

// FLOW-FAMILY REACH — named-flow narration, whole-transaction save order,
// order-of-execution, CDC subscribers, async-chain-depth, and the flow-family
// deactivate what-if. These shapes NAME a component by API name (a >=2-
// underscore token, unambiguously not prose) or ask what-runs-on-save / what-
// subscribes-to-CDC, and previously fell through to `unrouted`. Every case here
// uses SYNTHETIC component names. Precision guards below prove the new patterns
// never steal a compare, a plain schema, or an access question.
describe('flow-family REACH routing', () => {
  const routesTo = (q: string, intent: string, primaryTool: string) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe(intent);
    expect(r.plane).toBe('vault');
    expect(r.tools).toContain(primaryTool);
  };

  describe('explain-flow — named-flow narration', () => {
    it('routes "walk me through what <Flow> actually does step by step"', () => {
      routesTo('Walk me through what Foo_Bar_Flow actually does step by step', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "explain the purpose of <NamedFlow>"', () => {
      routesTo('Explain the purpose of RT_Create_New_Case', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "summarize the <Flow> for me"', () => {
      routesTo('Summarize the Widget_Sync_Flow for me', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "does <NamedFlow> fire on both insert and update"', () => {
      routesTo(
        'Does Order_Created_or_Edited_Process fire on both insert and update of Order__c or just one?',
        'explain-flow',
        'sfi.explain_flow',
      );
    });
    it('routes "is <NamedFlow> a before-save or after-save flow"', () => {
      routesTo('Is Order_Created_or_Edited_Process a before-save or after-save flow?', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "does <Flow> have fault connectors"', () => {
      routesTo(
        'Does Widget_Sync_Flow have fault connectors, or will a save error just blow up?',
        'explain-flow',
        'sfi.explain_flow',
      );
    });
    it('routes "what entry conditions gate <NamedFlow>"', () => {
      routesTo('What entry conditions gate Screen_Resume_Pause_Order_Process?', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "why would <NamedFlow> skip a record on save"', () => {
      routesTo('Why would Order_Save_RT_Orch skip a record on save?', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "what does <NamedFlow> copy from A to B"', () => {
      routesTo('What does Widget_Field_Sync_To_Contact copy from the Widget to the Contact?', 'explain-flow', 'sfi.explain_flow');
    });
    it('routes "does <NamedFlow> have any active version"', () => {
      routesTo(
        'Does DO_NOT_ACTIVATE_Create_Case have any active version, and why is it named like that?',
        'explain-flow',
        'sfi.explain_flow',
      );
    });
  });

  describe('trigger-order — whole-transaction save order', () => {
    it('routes "walk me through everything that fires in order"', () => {
      routesTo(
        'When a Case is created, walk me through everything that fires in order — assignment rules, flows, the works.',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "list every automation that fires when <object> status is set to Closed"', () => {
      routesTo('list every automation that fires when a Case Status is set to Closed.', 'trigger-order', 'sfi.what_happens_on_save');
    });
    it('routes "full save order on <object>"', () => {
      routesTo(
        "What's the full save order on Case — before-save flows, workflow, after-save flows separated?",
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "before-vs-after-save breakdown of every automation on <object>"', () => {
      routesTo(
        'Give me a before-vs-after-save breakdown of every automation on Order__c so I know where to insert new logic',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "which apex classes are triggered when a <object> is inserted"', () => {
      routesTo('which apex classes are triggered when a Order__c record is inserted', 'trigger-order', 'sfi.what_happens_on_save');
    });
    it('routes "run order between <FlowA> and any <object> record-triggered flow"', () => {
      routesTo(
        "What's the run order between Order_Save_RT_Orch and any Order record-triggered flow?",
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "assignment rules … run before or after the record-triggered flows"', () => {
      routesTo(
        'Are there assignment rules on Case, and do they run before or after the record-triggered flows?',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "does anything run on <object> update that would collide with <Flow>"', () => {
      routesTo(
        'Does anything run on Contact update that would collide with Calculate_Contact_Budget_Group?',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "what else fires on the same <object> save transaction"', () => {
      routesTo(
        'When Case_Review runs, what else fires on the same Case save transaction?',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
    it('routes "after-save flow … will it fight with the framework"', () => {
      routesTo(
        'If I add an after-save flow on Order__c to roll up totals, will it fight with the managed framework?',
        'trigger-order',
        'sfi.what_happens_on_save',
      );
    });
  });

  describe('order-of-execution — ordered handlers and pairwise conversion timing', () => {
    it('routes "which handler classes fire on <object> insert and in what order"', () => {
      routesTo('which handler classes fire on Contact insert and in what order', 'trigger-order', 'sfi.order_of_execution');
    });
    it('routes "does <NamedFlow> run before or after the lead conversion"', () => {
      routesTo(
        'Does Populate_Program_on_Lead run before or after the lead conversion?',
        'trigger-order',
        'sfi.order_of_execution',
      );
    });
  });

  describe('what-if-deactivate-flow — flow-family suffixes', () => {
    it('routes "what would happen if I deactivated <Orch>"', () => {
      routesTo(
        'What would happen if I deactivated Order_Save_RT_Orch — does anything else pick up the slack?',
        'what-if-deactivate-flow',
        'sfi.what_if_deactivate_flow',
      );
    });
    it('routes "suppose we deactivated <FlowA> versus <FlowB>"', () => {
      routesTo(
        "Suppose we deactivated DO_NOT_ACTIVATE_Create_Case versus RT_Create_New_Case — what's the real difference?",
        'what-if-deactivate-flow',
        'sfi.what_if_deactivate_flow',
      );
    });
    it('does NOT steal a plural embedded-Flow name from impact-analysis (regression guard)', () => {
      // "Foo_Flow_Attribute_Flows" ends in the PLURAL _Flows and has no
      // singular flow-family suffix, so it stays impact-analysis.
      expect(classifyQuestion('What if we deactivate Foo_Flow_Attribute_Flows?').intent).toBe('impact-analysis');
    });
  });

  describe('async-chain-depth — natural language', () => {
    it('routes "async-Apex-limit sensitive" concern', () => {
      routesTo(
        'Release-readiness for RT_Create_Task_Async — async-Apex-limit sensitive given the backlog?',
        'async-chain-depth',
        'sfi.async_chain_depth',
      );
    });
    it('routes "how deep does the async chain go from <thing>"', () => {
      routesTo('how deep does the async chain go from PaymentBatch', 'async-chain-depth', 'sfi.async_chain_depth');
    });
  });

  describe('CDC / event subscribers', () => {
    it('routes "what\'s subscribing to Change Data Capture"', () => {
      routesTo(
        "What's subscribing to Change Data Capture in this org? Will turning on CDC for Contact fan out?",
        'event-subscribers',
        'sfi.cdc_subscribers',
      );
    });
    it('routes "CDC or platform-event subscribers feeding <system>"', () => {
      routesTo(
        'Do we have any CDC or platform-event subscribers feeding the warehouse, or is that all API polling?',
        'event-subscribers',
        'sfi.cdc_subscribers',
      );
    });
  });

  describe('precision guards — new patterns must not steal clean routes', () => {
    it('does NOT steal "explain the difference between <FlowA> and <FlowB>" (compare, not narrate)', () => {
      // explain_flow narrates ONE flow; a two-flow comparison must fall through
      // rather than force a single-flow narration.
      expect(classifyQuestion('Explain the difference between RT_Create_New_Case and DO_NOT_ACTIVATE_Create_Case').intent)
        .not.toBe('explain-flow');
    });
    it('does NOT reclassify a plain "what runs when a Contact is saved" away from trigger-order', () => {
      expect(classifyQuestion('what runs when a Contact is saved').intent).toBe('trigger-order');
    });
    it('does NOT reclassify a lifecycle transition ("what runs when a Lead is converted")', () => {
      expect(classifyQuestion('what runs when a Lead is converted').intent).toBe('lifecycle-process');
    });
    it('a bare object schema question with no narration verb stays off explain-flow', () => {
      expect(classifyQuestion('what fields does Account have?').intent).not.toBe('explain-flow');
    });
    it('a permission-set access question with an underscore name stays off explain-flow', () => {
      // "Sales_Access" has only one underscore, so NAMED_COMPONENT_ID never
      // matches it, and there is no narration verb anyway.
      const r = classifyQuestion('who is assigned the Sales_Access permission set?');
      expect(r.intent).not.toBe('explain-flow');
    });
  });
});

// PERMISSIONS / ACCESS REACH routing. Natural admin phrasings the narrow
// access templates missed: "does/can <profile|permset> read/edit <object>",
// "who [adverb] can see <field>", "who [adverb] can run <flow>", "which flows
// exposed to <profile>", MFA/session posture per profile, record-type create
// gaps, plural-"records" why-cant asks. All SYNTHETIC names.
describe('permissions/access REACH routing', () => {
  const routesTo = (q: string, intent: string, primaryTool: string) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe(intent);
    expect(r.plane).toBe('vault');
    expect(r.tools).toContain(primaryTool);
  };

  describe('effective-permissions — does/can a named granter read/edit an object', () => {
    it('routes "Does the <profile> profile have any create/edit/delete on <Object>"', () => {
      routesTo(
        'Does the Sales profile have any create/edit/delete on Order__c, or just read?',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('routes "Does <permset> perm set give edit or read on <object>"', () => {
      routesTo(
        'Does the Sales_Access perm set give edit or read on Order__c, and who is assigned?',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('routes "Can the <profile> profile edit <Object.field> and move ... or only read"', () => {
      routesTo(
        'Can the Support profile edit Case.Status and move Cases through statuses, or only read them?',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('routes "Can the <profile> profile see any <Object> records, and which record types and fields"', () => {
      routesTo(
        'Can the Community profile see any Case records, and if so which record types and fields?',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('routes "which perm sets are stacked on top of the <profile> profile"', () => {
      routesTo(
        'Which perm sets are stacked on top of the Base_License profile for Sales users?',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('routes "for <A>, <B>, <C> perm sets, what does each contribute"', () => {
      routesTo(
        'For App_Perms, Object_Perms, System_Perms perm sets, what does each contribute — the division of access.',
        'effective-permissions',
        'sfi.effective_permissions',
      );
    });
    it('does NOT steal a "which layout does the <profile> profile see" layout question', () => {
      const r = classifyQuestion('Which layout does the Sales profile see on Account?');
      expect(r.intent).toBe('layout-access');
      expect(r.tools).not.toContain('sfi.effective_permissions');
    });
    it('does NOT steal a "why can\'t the <profile> profile see the record" why-cant ask', () => {
      const r = classifyQuestion("Why can't the Sales profile see the Account record?");
      expect(r.intent).toBe('why-cant-see');
      expect(r.tools).not.toContain('sfi.effective_permissions');
    });
    it('does NOT steal enumerative "which permission sets grant object access to <Object>"', () => {
      const r = classifyQuestion('Which permission sets grant object access to Order__c?');
      expect(r.intent).toBe('object-access');
      expect(r.tools).not.toContain('sfi.effective_permissions');
    });
  });

  describe('field-access — FLS on a named field', () => {
    it('routes "who [adverb] can see <Field__c> on the <Object> object"', () => {
      routesTo(
        'Who can actually see Secret_Code__c on the Order__c object besides Finance?',
        'field-access',
        'sfi.field_access_audit',
      );
    });
    it('routes "Can <team> edit <Object.field>, or read-only"', () => {
      routesTo(
        'Can the Analytics team edit Opportunity.Amount, or read-only for reporting?',
        'field-access',
        'sfi.field_access_audit',
      );
    });
    it('routes "why can\'t <users> edit <Field__c> even though they can see it"', () => {
      routesTo(
        "Why can't Support users edit Priority__c on the Case even though they can see it?",
        'field-access',
        'sfi.field_access_audit',
      );
    });
    it('routes "why can\'t <profile> edit <Object.field> on their own cases"', () => {
      routesTo(
        "why can't Support edit Case.Status on their own cases",
        'field-access',
        'sfi.field_access_audit',
      );
    });
    it('does NOT read the noun "access" (as in a managed-package "X access") as an FLS verb', () => {
      // "why can't my <profile> users generate the doc on <Object__c>? they
      // have <X> access." — no FLS verb, an unmodeled action; stays unrouted
      // rather than a false field-access.
      const r = classifyQuestion(
        "Why can't my Support users generate the doc on Order__c? They have Widget access.",
      );
      expect(r.tools).not.toContain('sfi.field_access_audit');
    });
    it('does NOT mistake a bare custom-OBJECT id for a field', () => {
      // "can a user see Order__c?" is an OBJECT visibility ask (no dotted field,
      // no "field" word) — field-access requires a dotted ref or an explicit
      // "field" word for the can/does shape.
      const r = classifyQuestion('Can a user see Order__c?');
      expect(r.intent).not.toBe('field-access');
    });
  });

  describe('who-can-run / user-ability — flow run access', () => {
    it('routes "who exactly can run the <Flow> flow" to who-can-run', () => {
      routesTo(
        'Who exactly can run the Foo_Bar_Flow flow — is it gated by profile or perm set?',
        'who-can-run',
        'sfi.who_can_run',
      );
    });
    it('routes "who [adverb] can run the <..._Screen_Flow>" (named-id, no bare "flow" word)', () => {
      routesTo(
        'Who can actually run the Lead_Assign_Screen_Flow?',
        'who-can-run',
        'sfi.who_can_run',
      );
    });
    it('routes "can the <profile> profile run <..._Screen_Flow>"', () => {
      routesTo(
        'Can the Support profile run Lead_Assign_Screen_Flow?',
        'who-can-run',
        'sfi.who_can_run',
      );
    });
    it('routes forward "which screen flows are exposed to the <profile> profile" to user-ability', () => {
      routesTo(
        'Which screen flows are exposed to the Sales profile?',
        'user-ability',
        'sfi.user_ability',
      );
    });
  });

  describe('profile-security — MFA / session posture across profiles', () => {
    it('routes "which profiles have MFA or session security settings weaker than the rest"', () => {
      const r = classifyQuestion(
        'Which profiles have MFA or session security settings that are weaker than the rest?',
      );
      expect(r.intent).toBe('profile-security');
      expect(r.tools).toContain('sfi.profile_security');
    });
    it('routes "what password policies and session timeout are set per profile" (setting→profile order)', () => {
      const r = classifyQuestion(
        'What password policies and session timeout are set per profile? I want strictest and loosest.',
      );
      expect(r.intent).toBe('profile-security');
      expect(r.tools).toContain('sfi.profile_security');
    });
    it('a generic "what is MFA" knowledge question does NOT hit profile-security', () => {
      expect(classifyQuestion('what is MFA in Salesforce?').intent).not.toBe('profile-security');
    });
  });

  describe('recordtype-availability — record-type create/pick gap', () => {
    it('routes "why won\'t the RecordTypeId let this user pick the <RT> record type"', () => {
      routesTo(
        "Why won't the RecordTypeId let this Sales user pick the Enterprise record type on a new Case?",
        'recordtype-availability',
        'sfi.recordtype_availability',
      );
    });
    it('routes "why can\'t the <profile> profile create the <RT> record type"', () => {
      routesTo(
        "Why can't the Sales profile create the Enterprise record type?",
        'recordtype-availability',
        'sfi.recordtype_availability',
      );
    });
  });

  describe('who-can-access-object / why-cant-see — object record access', () => {
    it('routes "is <Object__c> visible to the <profile> profile" to who-can-access-object', () => {
      routesTo(
        'Is Order__c visible to the Finance profile, and edit on the amount fields?',
        'who-can-access-object',
        'sfi.who_can_access_object',
      );
    });
    it('routes "why can\'t the <role> see <Object> records" (plural) to why-cant-see', () => {
      routesTo(
        'why cant the Manager role see Enrollment records for users below them in the hierarchy',
        'why-cant-see',
        'sfi.why_cant_user_see_record',
      );
    });
    it('routes "why can a <user> see <A> records but not <B>" to why-cant-see', () => {
      routesTo(
        'Why can a Support user see Order__c records but not the Payment__c linked to them?',
        'why-cant-see',
        'sfi.why_cant_user_see_record',
      );
    });
    it('routes "why can\'t a <user> edit <Object__c> records" (plural) to why-cant-see', () => {
      routesTo(
        "Why can't a Support user with Base_License edit Order__c records tied to their accounts?",
        'why-cant-see',
        'sfi.why_cant_user_see_record',
      );
    });
    it('a named-FIELD why-cant ("edit <Object.field>", no "records") stays on field-access', () => {
      const r = classifyQuestion("Why can't Support edit Case.Status on their own cases");
      expect(r.intent).toBe('field-access');
      expect(r.tools).not.toContain('sfi.why_cant_user_see_record');
    });
  });
});

// ===========================================================================
// USAGE / IMPACT / FIELD-FORENSICS REACH routing — synthetic names only.
// Converts unrouted-but-capable questions to routed. Every new rule is
// high-precision (named-field id, named component, or a distinctive frame) so
// it cannot steal an already-CLEAN question. Guards below prove the precision.
// ===========================================================================
describe('usage/impact/field-forensics REACH routing', () => {
  const routesTo = (q: string, intent: string, primaryTool: string) => {
    const r = classifyQuestion(q);
    expect(r.intent).toBe(intent);
    expect(r.tools).toContain(primaryTool);
  };

  describe('field-forensics — named-field asks land on the dedicated tool', () => {
    it('"give me the field 360 on <Field__c>" → field_360', () => {
      routesTo(
        'give me the field 360 on Order_Sync_Flag__c: who writes it, who reads it, is it worth keeping',
        'field-360',
        'sfi.field_360',
      );
    });
    it('"trace where <Object.field> goes after conversion" → field_lineage', () => {
      routesTo(
        'trace where Lead.Secret_Code__c goes after conversion - does it land on Contact or Order__c or get dropped',
        'field-lineage',
        'sfi.field_lineage',
      );
    });
    it('"what writes <Field__c> on <Object> — is it a flow?" → field_provenance', () => {
      routesTo(
        'What writes Foo_Status__c on the Order — is it a flow?',
        'field-provenance',
        'sfi.field_provenance',
      );
    });
    it('"what reads or writes <Field__c> on <Object>" (both directions) → find_field_anywhere', () => {
      routesTo(
        'What reads or writes Foo_Status__c on Order? Is any of that mapped from an external feed?',
        'find-field-anywhere-usage',
        'sfi.find_field_anywhere',
      );
    });
    it('"where do we store <concept> data across the org" → find_semantic_field', () => {
      routesTo(
        'where do we store consent / opt-out data across the org - Widget_Permission__c is one, what else',
        'find-semantic-field',
        'sfi.find_semantic_field',
      );
    });
    it('"do we already have a field for X" → find_semantic_field', () => {
      routesTo(
        "do we already have a field for the applicant's preferred contact time?",
        'find-semantic-field',
        'sfi.find_semantic_field',
      );
    });
    it('"can I safely delete <Field__c>, <Field__c> or are they referenced" → safe_to_delete_field', () => {
      routesTo(
        'can I safely delete Foo_Status__c, Widget_Status__c, and Order_Flag__c or are they referenced somewhere?',
        'safe-to-delete',
        'sfi.safe_to_delete_field',
      );
    });
  });

  describe('field what-if — schema simulators on a named field', () => {
    it('"if we made <Field__c> required but left others optional" → what_if_make_field_required', () => {
      routesTo(
        'What if we made Foo_Status__c required but left Widget_Status__c and Order_Flag__c optional — any layout inconsistencies?',
        'what-if-field',
        'sfi.what_if_make_field_required',
      );
    });
    it('"adding a required-field validation on <Object.field>" → what_if_make_field_required', () => {
      routesTo(
        'Will adding a required-field validation on Lead.Secret_Code__c block the auto-convert path?',
        'what-if-field',
        'sfi.what_if_make_field_required',
      );
    });
    it('"change <Object.field> from a picklist to a text field" → what_if_change_field_type', () => {
      routesTo(
        'Can you walk me through what happens if I change Case.Ticket_Code__c from a picklist to a text field?',
        'what-if-field',
        'sfi.what_if_change_field_type',
      );
    });
  });

  describe('impact — record-type / merge / package blast radius stays distinct from usage', () => {
    it('"what if I removed the <X> record type … which layouts and flows assume it" → get_impact', () => {
      // R3 §5b what-if change-type whitelist: record-type removal now lands
      // the DEDICATED honest route (no what_if_remove_record_type simulator
      // exists — the reason discloses that) with sfi.get_impact still primary.
      routesTo(
        'What if I removed the New_Lead_RT record type but kept Existing_Lead_RT — which page layouts and flows assume New_Lead_RT exists?',
        'record-type-removal-impact',
        'sfi.get_impact',
      );
    });
    it('"what would break if I merged the <A> and <B> profiles" (past tense) → what_if_merge_profiles', () => {
      routesTo(
        'What would break if I merged the Sales and Support profiles? They look 90% identical.',
        'profile-migration',
        'sfi.what_if_merge_profiles',
      );
    });
    it('"what custom fields did <pkg> inject across <objects>? Inventory for uninstall" → package_impact', () => {
      routesTo(
        'What custom fields did the vendor inject across Lead, Contact, Account, Case, Opportunity? Inventory for uninstall.',
        'package-impact',
        'sfi.package_impact',
      );
    });
  });

  describe('usage — "which <type> write/touch X" stays find_component_usages', () => {
    it('"Which flows write to <Object.field>" → find_component_usages', () => {
      routesTo(
        'Which flows write to Contact.Order_Sync_Flag__c?',
        'component-usage',
        'sfi.find_component_usages',
      );
    });
    it('"is <NamedFlow> triggered by <OtherFlow> or standalone" → find_component_usages', () => {
      routesTo(
        'Is the Notify_Email_Flow triggered by the Intake_Flow or standalone?',
        'component-usage',
        'sfi.find_component_usages',
      );
    });
    it('"does updating <Object.field> trigger any automation" → find_component_usages', () => {
      routesTo(
        'Does updating Contact.Order_Sync_Flag__c trigger any Case-related automation or is it purely display?',
        'component-usage',
        'sfi.find_component_usages',
      );
    });
    it('"is <Object> connected to Marketo" → find_component_usages', () => {
      routesTo(
        'is the Order object connected to Marketo or not',
        'component-usage',
        'sfi.find_component_usages',
      );
    });
    it('"is <NamedComponent> even needed anymore based on usage" → find_component_usages', () => {
      routesTo(
        'which fields feed the score - and is Widget_Score_Component even needed anymore based on usage',
        'component-usage',
        'sfi.find_component_usages',
      );
    });
    it('"which flow should update <field> and why isn\'t it running" → find_component_usages', () => {
      routesTo(
        "Order_Sync_Flag__c on Contact isn't updating when I close the case — which flow should do that and why isn't it running?",
        'component-usage',
        'sfi.find_component_usages',
      );
    });
  });

  describe('test-forensics', () => {
    it('"meaningful test audit on <X>" → meaningful_test_audit', () => {
      routesTo(
        'meaningful test audit on the Contact trigger handler - I suspect half these tests are meaningless',
        'test-coverage',
        'sfi.meaningful_test_audit',
      );
    });
    it('"tests are System.assert(true)" → meaningful_test_audit', () => {
      routesTo(
        'half these tests are just System.assert(true) - can you audit them',
        'test-coverage',
        'sfi.meaningful_test_audit',
      );
    });
  });

  describe('precision guards — new rules must NOT steal already-clean questions', () => {
    it('a bare-English "what writes it" (no named field) does NOT hit field-provenance', () => {
      const r = classifyQuestion('what writes it and when');
      expect(r.intent).not.toBe('field-provenance');
    });
    it('"which flows write X" is USAGE, NOT field-provenance (writers-only tool)', () => {
      const r = classifyQuestion('Which flows write Case.Status or Case.Ticket_Code__c?');
      expect(r.intent).toBe('component-usage');
      expect(r.tools).not.toContain('sfi.field_provenance');
    });
    it('"what reads or writes X" is find-field-anywhere, NOT field-provenance', () => {
      const r = classifyQuestion('What reads or writes Order.Widget_Status__c on Order?');
      expect(r.intent).toBe('find-field-anywhere-usage');
      expect(r.tools).not.toContain('sfi.field_provenance');
    });
    it('a plain "give me an org overview" is NOT field-360 (no named field / 360 phrase)', () => {
      const r = classifyQuestion('give me an overview of this org');
      expect(r.intent).not.toBe('field-360');
    });
    it('"what if I change Case.Amount to a currency field" is a field what-if, NOT record-type impact', () => {
      const r = classifyQuestion('what if I change Case.Amount from a number to a currency field?');
      expect(r.intent).toBe('what-if-field');
      expect(r.tools).toContain('sfi.what_if_change_field_type');
    });
    it('a bare "trace the call graph" (no named field) is NOT field-lineage', () => {
      const r = classifyQuestion('trace the call graph for the handler');
      expect(r.intent).not.toBe('field-lineage');
    });
    it('a plain "what breaks if I delete the Sales profile" (no record type) stays impact', () => {
      const r = classifyQuestion('what breaks if I delete the Sales profile');
      expect(r.intent).toBe('impact-analysis');
    });
  });

  // -----------------------------------------------------------------------
  // DISCOVERY / META / MISC REACH routing. Every named component uses a
  // SYNTHETIC api-name (never a real org id). Converts the low-volume,
  // high-variety discovery cluster while proving the precision guards that
  // keep the 277 already-clean questions from regressing.
  // -----------------------------------------------------------------------
  describe('discovery/meta/misc REACH routing', () => {
    // --- capabilities -----------------------------------------------------
    it('"what are you actually able to answer about this org" → capabilities', () => {
      const r = classifyQuestion('What are you actually able to answer about this org?');
      expect(r.intent).toBe('capabilities');
      expect(r.tools).toContain('sfi.capabilities');
    });
    it('"can you even tell me anything about record data … or is this just metadata" → capabilities', () => {
      const r = classifyQuestion(
        'can you even tell me anything about actual record data in here or is this just metadata',
      );
      expect(r.intent).toBe('capabilities');
    });
    it('"what can I ask" → capabilities', () => {
      const r = classifyQuestion('what can I ask about this org?');
      expect(r.intent).toBe('capabilities');
    });
    // GUARD: an org-CONTENT "what can this profile do" must NOT become capabilities.
    it('"what can the Sales_Access profile do" is NOT capabilities', () => {
      const r = classifyQuestion('what can the Sales_Access profile do?');
      expect(r.intent).not.toBe('capabilities');
    });

    // --- license usage ----------------------------------------------------
    it('"how many <A> and <B> licenses are we actually using vs paying for" → license-usage', () => {
      const r = classifyQuestion(
        'How many Platform and Community licenses are we actually using vs what we are paying for?',
      );
      expect(r.intent).toBe('license-usage');
      expect(r.tools).toContain('sfi.live_license_usage');
    });
    // GUARD: a perm-set ASSIGNMENT ask with a trailing "seats" must not hijack license-usage.
    it('"who is assigned the Sales_Access permission set — wasting seats?" is NOT license-usage', () => {
      const r = classifyQuestion(
        'who is assigned the Sales_Access permission set — are we wasting seats?',
      );
      expect(r.intent).not.toBe('license-usage');
    });

    // --- release readiness ------------------------------------------------
    it('"is this org release-ready … or are there blockers" → release-readiness', () => {
      const r = classifyQuestion(
        'Is this org release-ready for the summer push, or are there blockers I should know about?',
      );
      expect(r.intent).toBe('release-readiness');
      expect(r.tools).toContain('sfi.release_readiness_report');
    });

    // --- empty queues / groups (routing-trap symptom) ---------------------
    it('"why can members of <X>_Queue not see the cases routed to them" → empty-queues-groups', () => {
      const r = classifyQuestion(
        'Why can members of Support_Team_Queue not see the cases routed to them?',
      );
      expect(r.intent).toBe('empty-queues-groups');
      expect(r.tools).toContain('sfi.empty_queues_and_groups');
    });
    it('"why is the record sitting in the queue instead of getting picked up — queue members exist?" → empty-queues-groups', () => {
      const r = classifyQuestion(
        'Why is the Lead sitting in the Intake queue instead of getting picked up - queue members exist, right?',
      );
      expect(r.intent).toBe('empty-queues-groups');
    });
    it('"why can\'t a user reassign a Case to <Named>? they can touch every other queue" → empty-queues-groups', () => {
      const r = classifyQuestion(
        "Why can't a Premier user reassign a Case to Agent_Routing? They can touch every other queue.",
      );
      expect(r.intent).toBe('empty-queues-groups');
    });
    // GUARD: a neutral single-queue inspection stays get_component, NOT empty-queues.
    it('"which queues does <X>_Queue route to and who are the members" → queue-membership/get_component', () => {
      const r = classifyQuestion(
        'Which queues does Order_Task_Queue route to and who are the members?',
      );
      expect(r.intent).toBe('queue-membership');
      expect(r.tools).toContain('sfi.get_component');
    });
    // GUARD: a record-sharing "why can't X see an Account" (no queue) never lands on empty-queues.
    it('"why can\'t the Sales_Access profile see an Account record" is NOT empty-queues-groups', () => {
      const r = classifyQuestion(
        "why can't the Sales_Access profile see an Account record?",
      );
      expect(r.intent).not.toBe('empty-queues-groups');
    });

    // --- api version across a set of classes -----------------------------
    it('"what is the api version on the handlers … some classes feel ancient" → component-api-version/get_component', () => {
      const r = classifyQuestion(
        "what's the API version on the Foo_Bar handlers? some of these classes feel ancient",
      );
      expect(r.intent).toBe('component-api-version');
      expect(r.tools).toContain('sfi.get_component');
    });
    // GUARD (Family D contract): the SINGULAR "api version of X class" stays on schema.
    it('"what is the api version of the OrderService class" stays on schema', () => {
      const r = classifyQuestion('What is the API version of the OrderService class?');
      expect(r.intent).toBe('schema');
    });

    // --- compare two named components ------------------------------------
    it('"compare the <A> and <B> PSGs" → compare-components', () => {
      const r = classifyQuestion(
        'Compare the Sales_Access_Group and Sales_Ops_Group PSGs — I can never remember which one grants what.',
      );
      expect(r.intent).toBe('compare-components');
      expect(r.tools).toContain('sfi.compare_components');
    });
    it('"explain the difference between <FlowA> and <FlowB>" → compare-components (two named flows)', () => {
      const r = classifyQuestion(
        'Explain the difference between Foo_Bar_Flow and Baz_Qux_Flow',
      );
      expect(r.intent).toBe('compare-components');
    });
    // GUARD: a single-component "explain <Flow>" stays explain-flow, NOT compare.
    it('"explain Foo_Bar_Flow" (one flow, no compare frame) is NOT compare-components', () => {
      const r = classifyQuestion('Explain Foo_Bar_Flow step by step');
      expect(r.intent).not.toBe('compare-components');
    });
    // GUARD: two profiles still go through compare-profiles (owns the "profiles" noun).
    it('"what is the difference between the Sales and Support profiles" stays compare-profiles', () => {
      const r = classifyQuestion(
        'what is the difference between the Sales and Support profiles?',
      );
      expect(r.intent).toBe('compare-profiles');
    });

    // --- record-type enumeration (3+ named types) ------------------------
    it('"explain the difference between <A> and <B> and <C> record types" → record-type-enumeration/list_components', () => {
      const r = classifyQuestion(
        'explain the difference between New_Lead_RT and Existing_Lead_RT and Cold_Lead_RT record types',
      );
      expect(r.intent).toBe('record-type-enumeration');
      expect(r.tools).toContain('sfi.list_components');
    });

    // --- record-type availability (why can't open a record type) ---------
    it('"why can\'t anyone in the <PSG> open the <X> record type on Case" → recordtype-availability', () => {
      const r = classifyQuestion(
        'Why can\'t anyone in the Sales_Access permission set group open the Priority record type on Case? Wrong group?',
      );
      expect(r.intent).toBe('recordtype-availability');
      expect(r.tools).toContain('sfi.recordtype_availability');
    });

    // --- disambiguate concepts (natural language) ------------------------
    it('"does <Flow> relate to the <concept> concept" → disambiguate-concepts-nl', () => {
      const r = classifyQuestion(
        'Does Foo_Bar_Flow relate to the Owner concept on Orders?',
      );
      expect(r.intent).toBe('disambiguate-concepts-nl');
      expect(r.tools).toContain('sfi.disambiguate_concepts');
    });
    it('"is Status the same thing as Stage here" → disambiguate-concepts-nl', () => {
      const r = classifyQuestion('is Status the same thing as Stage here?');
      expect(r.intent).toBe('disambiguate-concepts-nl');
    });
  });
});

// R3 §5b — what-if CHANGE-TYPE WHITELIST + enumeration-vs-id gate. A what-if
// ask about a change type with NO simulator routes the dedicated honest read
// (never the nearest-neighbor what_if_*), and the id-required CPQ tools never
// commit on an org-wide enumeration ask. All names synthetic.
describe('R3 what-if change-type whitelist honest routes', () => {
  it('record-type removal → record-type-removal-impact (get_impact, no fabricated simulator)', () => {
    const r = classifyQuestion("What if I remove the 'Standard Support' record type from Case?");
    expect(r.intent).toBe('record-type-removal-impact');
    expect(r.tools).toContain('sfi.get_impact');
    expect(r.tools.some((t) => /what_if_/.test(t))).toBe(false);
    expect(r.reason).toMatch(/No what_if simulator exists/);
  });

  it('layout-assignment change → layout-assignment-change-impact (lookup + impact)', () => {
    const r = classifyQuestion(
      "what if I change the Standard_Case record type's page layout assignment?",
    );
    expect(r.intent).toBe('layout-assignment-change-impact');
    expect(r.tools).toContain('sfi.layout_assignments');
    expect(r.tools.some((t) => /what_if_/.test(t))).toBe(false);
  });

  it('flow variable-type change → flow-variable-type-change-impact (callers + explain)', () => {
    const r = classifyQuestion(
      'if I change the input variable type on the Zorp_Assignment_Screen_Flow from a single record to a collection, what breaks upstream?',
    );
    expect(r.intent).toBe('flow-variable-type-change-impact');
    expect(r.tools).toContain('sfi.get_impact');
    expect(r.tools.some((t) => /what_if_/.test(t))).toBe(false);
  });

  it('must-NOT-fire negatives: every BUILT what-if change type keeps its simulator route', () => {
    expect(classifyQuestion('what happens if I make Priority__c required on Case?').tools)
      .toContain('sfi.what_if_make_field_required');
    expect(classifyQuestion('what breaks if I deactivate Zorp_Flow?').tools)
      .toContain('sfi.what_if_deactivate_flow');
    expect(classifyQuestion('what breaks if I disable the Contact trigger?').tools)
      .toContain('sfi.what_if_disable_trigger');
    expect(
      classifyQuestion('What would break if I merged the Sales and Support profiles?').tools,
    ).toContain('sfi.what_if_merge_profiles');
  });
});

describe('R3 CPQ enumeration-vs-id gate', () => {
  it('org-wide "map the CPQ rule chain … evaluation order" routes the id-free enumeration path', () => {
    const r = classifyQuestion(
      'map the CPQ rule chain — price rules, product rules, and their evaluation order',
    );
    expect(r.intent).toBe('cpq-enumeration');
    expect(r.tools).toEqual(['sfi.cpq_dependency_map', 'sfi.list_components']);
  });

  it('"What CPQ quote template does the org use?" never commits the id-required breakdown', () => {
    const r = classifyQuestion('What CPQ quote template does the org use?');
    expect(r.intent).toBe('cpq-enumeration');
    expect(r.tools).not.toContain('sfi.cpq_quote_template_breakdown');
  });

  it('must-NOT-fire negative: a plain CPQ ask keeps the generic cpq route (per-id tools offered)', () => {
    const r = classifyQuestion('show me the cpq price rules touching Quote__c');
    expect(r.intent).toBe('cpq');
    expect(r.tools).toContain('sfi.cpq_rule_chain');
  });
});
