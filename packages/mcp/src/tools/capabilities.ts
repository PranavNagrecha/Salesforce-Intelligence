/**
 * Handler for the `sfi.capabilities` MCP tool — the product's self-description.
 *
 * The "what can I even ask?" map. A first-time caller (a human, or Claude on
 * their behalf) does not know that ~110 `sfi.*` tools exist, nor that the
 * recommended way in is a typo-tolerant natural-language question. This tool
 * answers that in one no-argument call: a categorized catalog of what the
 * knowledge base can answer, with example natural-language questions per
 * category, the canonical conversational pattern (resolve-first → clarify →
 * refresh-or-stop), the three slash commands, and the v0.1 honesty boundary.
 *
 * Design:
 *   - The category map + example questions are CURATED — there is no way to
 *     auto-generate a good "here's a real question you can ask" from a tool's
 *     technical description. Each category lists representative tool names so
 *     the caller can jump straight to the tool.
 *   - The headline `toolCount` is derived DYNAMICALLY from the live `V01_TOOLS`
 *     registry (imported lazily inside the handler to avoid an init-time
 *     import cycle with the dispatcher), so it never drifts from reality as
 *     tools are added or removed.
 *   - `conversationalGuidance` is the same resolve-first contract the entry
 *     skill teaches: it is surfaced here so a client that has NOT loaded the
 *     skill still learns to call `sfi.resolve` before guessing an id, to ask
 *     the user a clarifying question on `ambiguous`, and to offer
 *     `/sfi-refresh` or stop on `none`.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { ok, type Result, type UpdateCheckResult } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Zod schema for `sfi.capabilities`. Takes no arguments — it is a static
 * self-description plus a live tool count. Mirrors `sfi.org_overview` and
 * `sfi.get_manifest` (both `z.object({})`).
 */
export const capabilitiesInputSchema = z.object({});

/** Parsed input shape, inferred from `capabilitiesInputSchema`. */
export type CapabilitiesInput = z.infer<typeof capabilitiesInputSchema>;

/** One area of the product, with example questions and the tools that answer them. */
export interface CapabilityCategory {
  /** Stable short id (`find`, `impact`, ...). */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Plain-English description of what this area answers. */
  readonly description: string;
  /** Natural-language questions a user can literally ask. */
  readonly exampleQuestions: readonly string[];
  /** Representative `sfi.*` tool names for this area (not exhaustive). */
  readonly tools: readonly string[];
}

/**
 * A role-oriented entry point into the capability map. Personas group the
 * curated categories by WHO asks (admin / developer / architect / release-manager / support) so an agent
 * can orient a user by their job rather than by the product's internal
 * category taxonomy. The `categoryIds` reference `CapabilityCategory.id`s.
 */
/**
 * A question this persona asks + the ordered `sfi.*` tool PATH that answers it
 * (resolve-first when a component is named). The path turns "160 tools" into
 * "the operational questions a role actually asks" — the P12 product-experience
 * kernel. A unit test pins every tool here to a real `V01_TOOLS` entry so a
 * renamed/removed tool fails the build instead of advertising a dead path.
 */
export interface QuestionPath {
  readonly question: string;
  readonly tools: readonly string[];
}

export interface Persona {
  readonly id: 'admin' | 'developer' | 'architect' | 'release-manager' | 'support';
  readonly title: string;
  readonly description: string;
  /** Category ids (from `categories[]`) most relevant to this persona. */
  readonly categoryIds: readonly string[];
  /** The questions this persona asks + the ordered tool path that answers each. */
  readonly questionPaths: readonly QuestionPath[];
}

/** The recommended conversational pattern (mirrors the entry skill). */
export interface ConversationalGuidance {
  /** What to do first when the user names a component informally. */
  readonly startHere: string;
  /** What to do when resolution is `ambiguous`. */
  readonly onAmbiguous: string;
  /** What to do when resolution is `none`. */
  readonly onNone: string;
  /**
   * How to turn tool output into a grounded answer (SYNTH-01): build prose ONLY
   * from what the tools returned and pass it through `sfi.synthesize_answer`,
   * which flags any canonical id in the draft that no tool returned
   * (`hallucinatedIds`). Never emit an orphan id.
   */
  readonly groundAnswer: string;
}

/** One slash command the user can run in the client. */
export interface CommandInfo {
  readonly command: string;
  readonly purpose: string;
}

/** How answers are sourced — offline vault vs opt-in live org. */
export interface IntelligencePlane {
  readonly id: 'offline' | 'live' | 'hybrid';
  readonly title: string;
  readonly description: string;
  readonly default: boolean;
  readonly enablement: string;
  readonly tools: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CapabilitiesOutput {
  readonly product: string;
  readonly tagline: string;
  /** Live count of registered `sfi.*` tools (from the dispatcher registry). */
  readonly toolCount: number;
  /** Count of slash commands. */
  readonly commandCount: number;
  readonly intelligencePlanes: readonly IntelligencePlane[];
  readonly categories: readonly CapabilityCategory[];
  /** Role-oriented groupings of the categories (admin / developer / architect / release-manager / support), each with question paths. */
  readonly personas: readonly Persona[];
  readonly conversationalGuidance: ConversationalGuidance;
  readonly routingGuidance: ConversationalGuidance;
  readonly commands: readonly CommandInfo[];
  /** The v0.1 read-only/offline honesty boundary, surfaced verbatim. */
  readonly boundaries: readonly string[];
  readonly disclosure: string;
  /**
   * Whether a newer `sf-intelligence` is published on npm. Populated from a
   * fail-silent, cached, opt-out-able version check (see
   * `@sf-intelligence/core`'s `checkForUpdate`). When the check is disabled
   * (`SFI_NO_UPDATE_CHECK=1` / CI), failed, or not supplied by the caller, the
   * block reads `{ available: false, latestVersion: null, message: null }` — a
   * host must never narrate an update it could not confirm.
   */
  readonly update: UpdateAvailability;
  /**
   * Glossary of the trust tags a host will see on tool answers, keyed by the
   * VERBATIM runtime value (so the glossary cannot drift from the tags a tool
   * actually emits — see the contracts `ConfidenceLevel` / `Provenance`).
   */
  readonly trustGlossary: TrustGlossary;
}

/** The npm-update sub-report of {@link CapabilitiesOutput}. */
export interface UpdateAvailability {
  /** `true` only when a strictly newer version was confirmed on npm. */
  readonly available: boolean;
  /** The latest version on npm, or `null` when unknown / check disabled. */
  readonly latestVersion: string | null;
  /** A ready-to-print one-line nudge, or `null` when no update is available. */
  readonly message: string | null;
}

/** The "no update / not checked" default — never claims an unconfirmed update. */
const UPDATE_UNAVAILABLE: UpdateAvailability = {
  available: false,
  latestVersion: null,
  message: null,
};

/**
 * Project a fail-silent {@link UpdateCheckResult} onto the capabilities
 * `update` block. A `null` result (the caller ran no check) or a
 * not-actionable result both collapse to {@link UPDATE_UNAVAILABLE}, so the
 * block only ever advertises an update the check actually confirmed.
 */
const toUpdateAvailability = (
  result: UpdateCheckResult | null,
): UpdateAvailability => {
  if (result === null || !result.shouldUpdate || result.latestVersion === null) {
    return UPDATE_UNAVAILABLE;
  }
  return {
    available: true,
    latestVersion: result.latestVersion,
    message: `Update available: sf-intelligence@${result.latestVersion} — run \`npm i -g sf-intelligence@latest\`.`,
  };
};

/** Defines each trust tag a host will see, keyed by its verbatim runtime value. */
export interface TrustGlossary {
  readonly confidence: Readonly<
    Record<'declared' | 'parsed' | 'heuristic', string>
  >;
  readonly provenance: Readonly<
    Record<'offline_snapshot' | 'live_org' | 'hybrid', string>
  >;
  readonly completeness: Readonly<
    Record<'complete' | 'partial' | 'unknown', string>
  >;
}

/** The trust-tag glossary, keyed by the verbatim runtime value. */
const TRUST_GLOSSARY: TrustGlossary = {
  confidence: {
    declared: 'Salesforce metadata states it directly — highest trust.',
    parsed: 'Produced by AST/XML parsing of source — high trust.',
    heuristic:
      'Produced by regex / token / dynamic-string analysis — may have false positives; spot-check before acting.',
  },
  provenance: {
    offline_snapshot:
      'The last /sfi-refresh vault — the default for every vault tool.',
    live_org: 'An opt-in, capped, read-only sfi.live_* SOQL read.',
    hybrid: 'Fuses vault + live and discloses both provenances.',
  },
  completeness: {
    complete: 'The refresh modeled every metadata family the answer needs.',
    partial:
      'A family the answer depends on was not retrieved; absence means "not checked", never "none" (a coverageCaveat names the gap).',
    unknown: 'Coverage could not be determined.',
  },
};

/**
 * Curated capability map. Each category names a handful of representative
 * tools (not the full registry) plus example questions a user can ask
 * verbatim. Adding a tool to a category here is cheap; the headline count
 * stays honest via the live registry regardless.
 */
export const CATEGORIES: readonly CapabilityCategory[] = [
  {
    id: 'find',
    title: 'Find & identify components',
    description:
      'Locate an object, field, class, or flow even when you only half-remember its name. The resolver tolerates typos, filler words, and the org’s own misspellings.',
    exampleQuestions: [
      'Where is the email field?',
      'What is the payment object actually called?',
      'Find the field that stores a social security number.',
      'Is there a class that handles refunds?',
    ],
    tools: [
      'sfi.resolve',
      'sfi.search_components',
      'sfi.find_field_anywhere',
      'sfi.find_semantic_field',
      'sfi.get_component',
      'sfi.list_components',
    ],
  },
  {
    id: 'understand',
    title: 'Understand what something does',
    description:
      'Explain a single component in plain business terms — what a field means, what a flow or automation is for, what an Apex method or formula does, the full profile of a field, or everything that already runs when a record is saved.',
    exampleQuestions: [
      'What does the Payment_Status__c field mean?',
      'Explain what this flow does.',
      'What is the Lead_Nurture flow for?',
      'Walk me through this automation.',
      'What already runs when a Case is saved?',
      'Is my new automation a duplicate of something that already fires on save?',
      'Give me the full profile of this field.',
      'What happens when an Opportunity becomes Closed Won?',
    ],
    tools: [
      'sfi.explain_field',
      'sfi.explain_flow',
      'sfi.explain_apex_method',
      'sfi.explain_formula',
      'sfi.field_meaning',
      'sfi.what_happens_on_save',
      'sfi.lifecycle_process',
      'sfi.field_360',
    ],
  },
  {
    id: 'impact',
    title: 'Impact & dependencies',
    description:
      'See what depends on a component and what would break before you change or delete it — the dependency graph, what touches a field across automation and code, and what-if simulations.',
    exampleQuestions: [
      'What breaks if I delete this field?',
      'The business wants to delete this field — what evidence do I need that no one uses it?',
      'What touches this field across automation and code?',
      'What depends on this Apex class?',
      'Is it safe to deactivate this flow?',
      'What if I make this field required?',
      'What of mine breaks if I uninstall the SBQQ package?',
    ],
    tools: [
      'sfi.get_impact',
      'sfi.downstream_effects',
      'sfi.get_edges',
      'sfi.field_lineage',
      'sfi.safe_to_delete_field',
      'sfi.what_if_deactivate_flow',
      'sfi.package_impact',
    ],
  },
  {
    id: 'access',
    title: 'Permissions, sharing & access',
    description:
      'Answer who-can-see-what and why — profile and permission-set grants, field-level security, and the record-visibility cascade.',
    exampleQuestions: [
      'Why can’t this user see this record?',
      'Who can edit the Salary field?',
      'Which permission sets are assigned to nobody?',
      'Summarize sharing for the Account object.',
    ],
    tools: [
      'sfi.why_cant_user_see_record',
      'sfi.crud_fls_audit',
      'sfi.field_access_audit',
      'sfi.generate_sharing_summary',
      'sfi.unassigned_permission_sets',
    ],
  },
  {
    id: 'automation',
    title: 'Automation & code behavior',
    description:
      'Trace what runs and when — the order of execution on save, the Apex call graph, governor-limit risks, dead code, and test coverage.',
    exampleQuestions: [
      'What automation runs when a Case is created?',
      'Show the call graph for this Apex class.',
      'Which Apex methods have no real test coverage?',
      'Which tests should I run for the classes I changed?',
      'Where are the governor-limit risks?',
    ],
    tools: [
      'sfi.order_of_execution',
      'sfi.call_graph',
      'sfi.governor_limit_risks',
      'sfi.find_dead_code',
      'sfi.test_coverage_for_method',
      'sfi.tests_for_change',
      'sfi.method_reachability',
    ],
  },
  {
    id: 'integration',
    title: 'Integrations & external systems',
    description:
      'Map how the org talks to the outside world — named credentials, endpoints, outbound messages, and change-data-capture subscribers.',
    exampleQuestions: [
      'What external systems does this org talk to?',
      'List every outbound endpoint.',
      'Who subscribes to change events?',
    ],
    tools: [
      'sfi.integration_map',
      'sfi.endpoint_catalog',
      'sfi.outbound_message_catalog',
      'sfi.cdc_subscribers',
    ],
  },
  {
    id: 'docs',
    title: 'Generate documentation',
    description:
      'Produce ready-to-share artifacts — an org tour, an admin handbook, an architecture overview, a data dictionary, or an onboarding doc.',
    exampleQuestions: [
      'Give me a tour of this org.',
      'Generate an admin handbook.',
      'Build a data dictionary.',
      'Write an onboarding doc for a new developer.',
    ],
    tools: [
      'sfi.org_overview',
      'sfi.generate_admin_handbook',
      'sfi.generate_architecture_overview',
      'sfi.generate_data_dictionary',
      'sfi.generate_onboarding_doc',
    ],
  },
  {
    id: 'govern',
    title: 'Health, freshness & audit',
    description:
      'Check the vault’s freshness, see what changed recently, inventory PII, and score technical debt — the governance surface.',
    exampleQuestions: [
      'Is my vault up to date?',
      'What changed since last month?',
      'Where is PII stored in this org?',
      'How much technical debt is there?',
    ],
    tools: [
      'sfi.health_check',
      'sfi.coverage_report',
      'sfi.get_manifest',
      'sfi.org_pulse',
      'sfi.changed_since',
      'sfi.trend',
      'sfi.churn',
      'sfi.baseline_status',
      'sfi.last_modified',
      'sfi.pii_inventory',
      'sfi.tech_debt_score',
      'sfi.org_risk_report',
      'sfi.release_readiness_report',
    ],
  },
  {
    id: 'live',
    title: 'Live org data (opt-in)',
    description:
      'Read-only runtime facts from the connected org via Salesforce CLI — counts, samples, field population, org limits. Default conversation stays offline; live tools never silently substitute vault answers.',
    exampleQuestions: [
      'How many Accounts have Industry filled in?',
      'Sample 10 Opportunities in Negotiation.',
      'What are the current org governor limits?',
      'Which paid licenses are provisioned but unused?',
    ],
    tools: [
      'sfi.live_count',
      'sfi.live_sample',
      'sfi.live_describe',
      'sfi.live_field_population',
      'sfi.live_group_count',
      'sfi.live_stale_records',
      'sfi.live_recent_activity',
      'sfi.live_aggregate',
      'sfi.live_duplicate_check',
      'sfi.live_owner_breakdown',
      'sfi.live_storage_by_object',
      'sfi.live_org_limits',
      'sfi.live_inactive_users',
      'sfi.live_license_usage',
      'sfi.live_permset_holders',
      'sfi.live_zombie_accounts',
      'sfi.live_group_members',
      'sfi.live_user_permsets',
      'sfi.live_report_usage',
      'sfi.live_folder_access',
      'sfi.live_email_template_usage',
      'sfi.live_org_health',
    ],
  },
];

/**
 * Role-oriented groupings over `CATEGORIES`. Each persona points at the
 * category ids most relevant to its job so an agent can orient a user by role
 * ("I'm an admin") instead of the internal taxonomy. Curated — adding a
 * category to a persona is cheap; a unit test pins every `categoryIds` entry to
 * a real category so the grouping cannot drift.
 */
const PERSONAS: readonly Persona[] = [
  {
    id: 'admin',
    title: 'Administrator',
    description:
      'Configuration and operations — who can see/edit/create records, what runs on save, page layouts and record types, and data-quality / compliance hygiene.',
    categoryIds: ['access', 'automation', 'govern', 'find', 'docs'],
    questionPaths: [
      { question: 'Who can edit the SSN field?', tools: ['sfi.resolve', 'sfi.field_access_audit'] },
      { question: 'Who can see this object’s records?', tools: ['sfi.resolve', 'sfi.who_can_access_object'] },
      { question: 'What runs when a Case is created?', tools: ['sfi.resolve', 'sfi.what_happens_on_save'] },
      { question: 'Which fields look unused and might be safe to retire?', tools: ['sfi.unused_fields_deep', 'sfi.safe_to_delete_field'] },
    ],
  },
  {
    id: 'developer',
    title: 'Developer',
    description:
      'Code and change safety — dependency and impact analysis, what reads/writes a field, Apex call graphs and test coverage, and the integration code surface.',
    categoryIds: ['impact', 'automation', 'integration', 'understand', 'find'],
    questionPaths: [
      { question: 'What breaks if I change this field’s type?', tools: ['sfi.resolve', 'sfi.what_if_change_field_type', 'sfi.get_impact'] },
      { question: 'Trace this field’s lineage.', tools: ['sfi.resolve', 'sfi.field_lineage', 'sfi.get_edges'] },
      { question: 'What is the test coverage for this method?', tools: ['sfi.resolve', 'sfi.apex_test_coverage', 'sfi.test_coverage_for_method'] },
      { question: 'Show the call graph for this class.', tools: ['sfi.resolve', 'sfi.call_graph'] },
      { question: 'Where is this class used?', tools: ['sfi.resolve', 'sfi.find_component_usages'] },
    ],
  },
  {
    id: 'architect',
    title: 'Architect',
    description:
      'System-level shape — integration topology, blast radius of a change, cross-org / sandbox-vs-prod comparison, and generated architecture documentation.',
    categoryIds: ['integration', 'impact', 'docs', 'govern', 'understand'],
    questionPaths: [
      { question: 'Show the org’s integration topology.', tools: ['sfi.integration_map'] },
      { question: 'Generate an architecture overview.', tools: ['sfi.generate_architecture_overview'] },
      { question: 'What is the blast radius of deleting this object?', tools: ['sfi.resolve', 'sfi.get_impact'] },
      { question: 'What depends on this component?', tools: ['sfi.resolve', 'sfi.find_component_usages'] },
      { question: 'How does this profile differ between sandbox and prod?', tools: ['sfi.resolve', 'sfi.compare_profile_across_vaults'] },
    ],
  },
  {
    id: 'release-manager',
    title: 'Release Manager',
    description:
      'Change readiness and risk — is the org safe to deploy, what changed since the last refresh, the blast radius and risk of a specific change, and which tests to run for it.',
    categoryIds: ['impact', 'govern', 'find', 'docs'],
    questionPaths: [
      { question: 'Is this org ready to deploy?', tools: ['sfi.release_readiness_report'] },
      { question: 'What changed since the last refresh?', tools: ['sfi.what_changed_since_refresh', 'sfi.changed_since'] },
      { question: 'What breaks if I change this field?', tools: ['sfi.resolve', 'sfi.field_change_advisor', 'sfi.get_impact'] },
      { question: 'Which tests should I run for this change?', tools: ['sfi.resolve', 'sfi.tests_for_change'] },
    ],
  },
  {
    id: 'support',
    title: 'Support / Operations',
    description:
      'Why a user sees what they see and what an action triggers — record-visibility diagnostics, value/stage lifecycle effects, who can run a flow, and the honest boundary for runtime "what happened" questions.',
    categoryIds: ['access', 'automation', 'understand', 'find'],
    questionPaths: [
      { question: 'Why can’t this user see this record?', tools: ['sfi.resolve', 'sfi.why_cant_user_see_record'] },
      { question: 'What happens when this Opportunity becomes Closed Won?', tools: ['sfi.resolve', 'sfi.lifecycle_process'] },
      { question: 'Who can run this flow?', tools: ['sfi.resolve', 'sfi.who_can_run'] },
      { question: 'Who changed this record? (runtime audit trail)', tools: ['sfi.route_question', 'sfi.last_modified'] },
    ],
  },
];

const INTELLIGENCE_PLANES: readonly IntelligencePlane[] = [
  {
    id: 'offline',
    title: 'Offline vault (default)',
    description:
      'Metadata, dependencies, permissions, and synthesis over the last /sfi-refresh snapshot. Every vault tool uses provenance offline_snapshot unless stated otherwise.',
    default: true,
    enablement: 'Always on after /sfi-refresh.',
    tools: ['sfi.resolve', 'sfi.get_impact', 'sfi.safe_to_delete_field', 'sfi.coverage_report'],
  },
  {
    id: 'live',
    title: 'Live read-only org',
    description:
      'SOQL counts, samples, describe, and limits against the authenticated org. Fail-closed when disabled — no fallback to stale vault claims.',
    default: false,
    enablement:
      'Opt-in per org: grant one-time consent with sfi.live_consent { grant: true } (persists across sessions; strictly read-only), or set SFI_LIVE_PLANE_ENABLED=1, or pass liveEnabled: true on a single sfi.live_* call.',
    tools: [
      'sfi.live_count',
      'sfi.live_sample',
      'sfi.live_field_population',
      'sfi.live_group_count',
      'sfi.live_stale_records',
      'sfi.live_recent_activity',
      'sfi.live_aggregate',
      'sfi.live_duplicate_check',
      'sfi.live_owner_breakdown',
      'sfi.live_storage_by_object',
      'sfi.live_org_limits',
      'sfi.live_inactive_users',
      'sfi.live_license_usage',
      'sfi.live_permset_holders',
      'sfi.live_zombie_accounts',
      'sfi.live_group_members',
      'sfi.live_user_permsets',
      'sfi.live_report_usage',
      'sfi.live_folder_access',
      'sfi.live_email_template_usage',
      'sfi.live_org_health',
      'sfi.live_consent',
    ],
  },
  {
    id: 'hybrid',
    title: 'Hybrid (offline + live)',
    description:
      'Combine static impact from the vault with live population or counts when the user needs both "what references this?" and "how empty is it in production?"',
    default: false,
    enablement: 'Enable live plane, then pair vault tools with sfi.live_*; disclose both provenance values.',
    tools: ['sfi.get_impact', 'sfi.live_field_population', 'sfi.field_cleanup_candidates'],
  },
];

/**
 * Conversational contract surfaced so a client learns the pattern even
 * without the entry skill loaded. This is the headline behavior: never
 * silently guess an id; resolve first, then ask or offer.
 */
const CONVERSATIONAL_GUIDANCE: ConversationalGuidance = {
  startHere:
    'When the user names a component informally (“the email field”, “payment object”, a typo), call sfi.resolve FIRST. It returns ranked candidates with a disposition: exact | ambiguous | none. Do not guess a canonical id from memory.',
  onAmbiguous:
    'On disposition=ambiguous the response carries a ready-to-ask clarifying question with one option per candidate. Present it via your clarifying-question UI (e.g. AskUserQuestion) and let the user pick — do not silently choose one.',
  onNone:
    'On disposition=none nothing matched confidently. Offer the user the nextActions: pull fresh metadata from the org (the /sfi-refresh command) in case the vault is stale, or stop / rephrase. Never fabricate a match.',
  groundAnswer:
    'After the tool(s) return, build your prose ONLY from their output and pass it through sfi.synthesize_answer { question, draft }. It returns hallucinatedIds — canonical ids in your draft that NO tool returned. If hallucinatedIds is non-empty, remove those ids before answering. Never narrate an id a tool did not return.',
};

/** The three slash commands the client exposes. */
const COMMANDS: readonly CommandInfo[] = [
  { command: '/sfi-init', purpose: 'First-time setup: create org-kb/ and pick a target-org alias.' },
  { command: '/sfi-refresh', purpose: 'Re-retrieve from the org and rebuild the vault when the org has changed.' },
  { command: '/sfi-status', purpose: 'Print vault freshness, source-tree hash, and component counts.' },
];

/**
 * The v0.1 capability boundary, surfaced verbatim so the caller never
 * over-promises. Mirrors the CLAUDE.md "v0.1 capability boundary" section.
 */
const ROUTING_GUIDANCE: ConversationalGuidance = {
  startHere:
    'On a vague or broad question, call sfi.route_question first — it returns the plane (vault | live | hybrid | unknown) and the tools to run. Default to the offline vault. Use sfi.live_* only for record counts, samples, population, describe, org limits, or inactive users — and only when the org has live consent (sfi.live_consent), SFI_LIVE_PLANE_ENABLED=1, or liveEnabled: true. Before destructive verdicts, call sfi.coverage_report.',
  onAmbiguous:
    'On ambiguous resolution, clarify the component first. If the user wants live data and live is disabled, say so and offer to enable it once with sfi.live_consent { grant: true } (read-only) — do not guess from the vault.',
  onNone:
    'On none, offer /sfi-refresh for metadata gaps. For live-record questions when offline, name sfi.live_count or sfi.live_sample and the consent requirement — never invent counts. When route_question returns toolCandidates (no rule placed the question, or it matched only weakly), follow its `guidance`: those candidates are an advisory shortlist — pick the right tool(s) from them, resolve any named component, run them, then synthesize. Do NOT say the capability is unbuilt when candidates are offered. Only a true unknown with NO candidates means the capability is not built yet (the gap is logged).',
  groundAnswer:
    'Run the routed tools, then synthesize ONE answer from their output via sfi.synthesize_answer { question, draft }. It returns hallucinatedIds — any canonical id you wrote that no tool returned. Strip those before answering; cite only ids the tools produced, with their provenance.',
};

const BOUNDARIES: readonly string[] = [
  'Read-only: no writes to Salesforce from any tool.',
  'Offline by default: vault tools use the last /sfi-refresh snapshot. Live tools are opt-in and labeled provenance live_org.',
  'Coverage-aware: partial vault coverage downgrades unqualified “safe” and “none” claims — check sfi.coverage_report first.',
  'SAST suppression: use sfi.baseline_acknowledge for false positives; sfi.baseline_status lists what is muted.',
  'Change over time: sfi.trend and sfi.churn need persisted `sfi snapshot create` captures after refreshes.',
  'Metadata-first: record-level answers require sfi.live_* (when enabled) or direct sf data query — not silent vault inference.',
  'Every named org artifact is backed by a tool call and a canonical id; the tools do not speculate from general Salesforce knowledge.',
];

const CAPABILITIES_DISCLOSURE =
  'This is a map of what the knowledge base can answer, not a guarantee every tool applies to your org. Counts and categories are accurate to the installed build; answers about your org are only as fresh as the last vault refresh.';

/**
 * The `sfi.capabilities` MCP tool. Returns the product self-description:
 * a categorized catalog with example questions, the conversational pattern,
 * the slash commands, and the honesty boundary. Takes no arguments.
 *
 * The optional `update` argument carries an already-resolved npm-version-check
 * result (from `@sf-intelligence/core`'s `checkForUpdate`). It is injected —
 * not fetched here — so this no-arg tool stays cheap, deterministic, and free
 * of network I/O; a caller that already ran the fail-silent check passes its
 * result through. When omitted the `update` block reports "no update".
 *
 * @example
 *   const r = await capabilitiesHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.toolCount, r.value.data.categories.length);
 */
export const capabilitiesHandler = async (
  ctx: Context,
  _input: CapabilitiesInput,
  update: UpdateCheckResult | null = null,
): Promise<Result<McpResponse<CapabilitiesOutput>, McpError>> => {
  // Derive the live tool count from the dispatcher registry. Imported here
  // (not at module top level) so the index <-> capabilities import cycle
  // resolves at call-time, when both modules are fully initialized.
  const { V01_TOOLS } = await import('./index.js');

  return ok({
    data: {
      product: 'sf-intelligence',
      tagline:
        'Offline, MCP-first knowledge base for one Salesforce org — ask questions in plain language, get answers grounded in the org’s real metadata.',
      toolCount: V01_TOOLS.length,
      commandCount: COMMANDS.length,
      intelligencePlanes: INTELLIGENCE_PLANES,
      categories: CATEGORIES,
      personas: PERSONAS,
      conversationalGuidance: CONVERSATIONAL_GUIDANCE,
      routingGuidance: ROUTING_GUIDANCE,
      commands: COMMANDS,
      boundaries: BOUNDARIES,
      disclosure: CAPABILITIES_DISCLOSURE,
      update: toUpdateAvailability(update),
      trustGlossary: TRUST_GLOSSARY,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
