/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allRoutableTools,
  classifyQuestion,
  gapLogPath,
  logGapIfAny,
  type Plane,
} from '../src/intent-router.js';
import { V01_TOOLS } from '../src/tools/index.js';

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
  { q: 'Is it safe to update the External_Ref_SIS_ID__c field values?', intent: 'value-change', plane: 'vault' },
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
    // Opt-in live-plane helpers the agent invokes directly inside a live flow:
    'sfi.blast_radius_live', 'sfi.live_automation_fired', 'sfi.live_describe',
    'sfi.live_picklist_usage', 'sfi.live_stale_check',
    // Sub-tools / specialized drills reached via a bundle or after `resolve`:
    'sfi.decision_table_browse',
    // sfi.explain_formula is now router-reachable (QA-Bundle-2 save-behavior rule).
    'sfi.field_meaning',
    'sfi.find_semantic_field', 'sfi.fleet_find',
    // sfi.layout_assignments is now router-reachable (P12-ROUTER-layout-assignments).
    // sfi.lookup_record is now router-reachable (P14-ROUTER-cmdt-record-values).
    'sfi.org_pulse',
    'sfi.promotion_readiness', 'sfi.test_coverage_for_method',
    // sfi.profile_security is a specialized login/session security drill reached
    // AFTER a profile is in hand (via `resolve`), analogous to the what-if
    // profile drills — not a natural-language intent's primary answer yet.
    'sfi.profile_security',
    // sfi.what_if_change_method_signature is now router-reachable
    // (P14-ROUTER-method-signature-impact); sfi.what_changed_since_refresh
    // is now router-reachable (P14-ROUTER-stress-20).
    'sfi.what_if_deactivate_flow', 'sfi.what_if_disable_trigger',
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

describe('enterprise route metadata', () => {
  it('classifies route risk and exposes competing intents', () => {
    const r = classifyQuestion('What breaks if I delete the Account field?');
    expect(r.risk).not.toBe('informational');
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.confidence).toBe('low');
    expect(r.clarification?.required).toBe(true);
    expect(r.clarification?.question).toContain('full dependency blast radius');
    expect(r.clarification?.fallback?.intent).toBe('impact-analysis');
  });

  it('stops on generic object access because CRUD and record visibility differ', () => {
    const r = classifyQuestion('Who can access Account?');
    expect(r.intent).toBe('who-can-access-object');
    expect(r.risk).toBe('security-sensitive');
    expect(r.alternatives.map((alternative) => alternative.intent)).toContain('object-access');
    expect(r.clarification?.required).toBe(true);
    expect(r.clarification?.question).toContain('record-level visibility');
    expect(r.clarification?.question).toContain('object-level CRUD permissions');
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
