/**
 * Curated greenfield / "New Org" guidance topics for the `knowledge` plane.
 *
 * The offline vault answers questions about THIS org's metadata. Greenfield
 * / best-practice questions ("Flow vs Apex?", "what are the governor limits?",
 * "how should I set up SFDX?") have no org-specific answer — they are general
 * Salesforce knowledge. Rather than fabricate a vault answer (which the product
 * never does) or return a bare `unknown`, the `knowledge` plane surfaces a
 * SHORT, honest summary plus POINTERS to official Salesforce documentation.
 *
 * Honesty contract:
 *   - Summaries are general Salesforce guidance, explicitly NOT specific to the
 *     connected org (the `disclosure` field in the tool output says so).
 *   - `docs` links point only to stable official Salesforce properties
 *     (developer.salesforce.com Apex/SFDX guides, help.salesforce.com,
 *     trailhead.salesforce.com). The summary carries the substance; the link is
 *     a "learn more" pointer, never the sole answer.
 *   - This file contains NO org data and is independent of the vault.
 */

/** One pointer to official Salesforce documentation. */
export interface DocLink {
  readonly label: string;
  readonly url: string;
}

/** One curated guidance topic. */
export interface KnowledgeTopic {
  /** Human title. */
  readonly title: string;
  /** Plain-English best-practice summary (the substance — general, not org-specific). */
  readonly summary: string;
  /** Pointers to official Salesforce docs/Trailhead for the topic. */
  readonly docs: readonly DocLink[];
}

const TRAILHEAD: DocLink = { label: 'Trailhead', url: 'https://trailhead.salesforce.com' };
const HELP: DocLink = { label: 'Salesforce Help', url: 'https://help.salesforce.com' };

/**
 * Topic keys are stable, kebab-case, and referenced by the router's `knowledge`
 * rules (`suggestedArgs.topic`). Keep keys stable — they are an API surface.
 */
export const KNOWLEDGE_TOPICS: Readonly<Record<string, KnowledgeTopic>> = Object.freeze({
  'flow-vs-apex': {
    title: 'Flow vs Apex — when to use which',
    summary:
      'Prefer declarative record-triggered Flow for most automation; reach for an Apex trigger only when you need logic Flow cannot do well: complex bulk processing, callouts with fine control, recursion management, custom error handling, or operations across many records/objects in one transaction. Keep one record-triggered Flow (or one trigger) per object/timing and delegate to a handler. Avoid mixing Workflow Rules / Process Builder with Flow on the same object.',
    docs: [
      { label: 'Record-Triggered Automation (Architects)', url: 'https://architect.salesforce.com/decision-guides/trigger-automation' },
      TRAILHEAD,
    ],
  },
  'order-of-execution': {
    title: 'Apex order of execution on save',
    summary:
      'On save Salesforce runs, in order: system validation, before-save record-triggered flows, before triggers, system + custom validation rules, duplicate rules, after triggers, assignment/auto-response/workflow rules, processes & after-save flows, escalation rules, roll-up summary recalculation, sharing recalculation, then commit and post-commit (async, email, @future). Knowing the order explains why a field looks stale or an automation "didn\'t fire".',
    docs: [
      { label: 'Apex Developer Guide — Triggers and Order of Execution', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm' },
    ],
  },
  'governor-limits': {
    title: 'Apex governor limits to design around',
    summary:
      'Per-transaction limits force bulk-safe design: 100 SOQL queries (200 async), 150 DML statements, 50,000 rows retrieved, 10s sync / 60s async CPU time, 6 MB sync / 12 MB async heap, 100 callouts, 10 emails. Never put SOQL/DML inside loops; bulkify; query selectively; move heavy work to Batch/Queueable.',
    docs: [
      { label: 'Apex Developer Guide — Execution Governors and Limits', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm' },
    ],
  },
  'async-apex': {
    title: 'Asynchronous Apex options',
    summary:
      'Future (@future): simplest fire-and-forget, primitives only, for callouts/decoupling — no chaining, no monitoring. Queueable: like future but accepts objects, can chain, returns a job id. Batch (Database.Batchable): process millions of records in chunks (start/execute/finish), higher limits. Schedulable: run Apex on a cron schedule (often to enqueue a Batch). Choose by data volume, need to chain/monitor, and scheduling.',
    docs: [
      { label: 'Apex Developer Guide — Asynchronous Apex', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_async_overview.htm' },
      TRAILHEAD,
    ],
  },
  'trigger-framework': {
    title: 'Apex trigger framework pattern',
    summary:
      'Adopt one-trigger-per-object that immediately delegates to a handler class; keep zero business logic in the trigger body. A framework gives you context routing (before/after, insert/update/...), recursion control (static guards), and bulk-safe handler methods. Popular patterns: a simple hand-rolled handler base class, or community frameworks. Consistency matters more than which framework.',
    docs: [
      { label: 'Apex Developer Guide — Triggers', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm' },
      TRAILHEAD,
    ],
  },
  'bulkification': {
    title: 'Bulkified Apex best practices',
    summary:
      'Assume every trigger/method processes up to 200 records. Query once with maps keyed by id, never inside loops; collect DML into lists and do one insert/update outside loops; use collections and Maps for lookups; pass record collections, not single records. Test with ≥200-record bulk data, not one record.',
    docs: [
      { label: 'Apex Developer Guide — Bulk Trigger Idioms', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_bulk_idioms.htm' },
    ],
  },
  'apex-testing': {
    title: 'Apex testing, coverage, and test data',
    summary:
      'Production deploys require ≥75% org-wide Apex coverage and all tests passing (each trigger must have some coverage). Coverage is a floor, not the goal: assert real behavior with System.assertEquals on distinct expected/actual values. Build test data in @isTest test-data-factory classes; use Test.startTest/stopTest for limits and async; avoid SeeAllData=true. Structure: one test class per class, descriptive methods, positive + negative + bulk cases.',
    docs: [
      { label: 'Apex Developer Guide — Testing Apex', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_testing.htm' },
    ],
  },
  'apex-callouts': {
    title: 'Making external callouts from Apex',
    summary:
      'Use Named Credentials for endpoints + auth (never hardcode URLs/secrets); call via HttpRequest/HttpResponse or external services. Callouts cannot follow uncommitted DML in the same transaction — do them before DML or from async (@future(callout=true)/Queueable). Set timeouts, handle non-200s, and write tests with HttpCalloutMock.',
    docs: [
      { label: 'Apex Developer Guide — Invoking Callouts Using Apex', url: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_callouts.htm' },
    ],
  },
  'sfdx-source-driven-dev': {
    title: 'Source-driven development with SFDX',
    summary:
      'Treat metadata as source in version control. Use a Salesforce DX project (sfdx-project.json), scratch orgs for feature development, and the `sf` CLI to retrieve/deploy/convert source. Pair with a CI/CD pipeline (validate + run tests on PR, deploy on merge) and unlocked packages for modular delivery.',
    docs: [
      { label: 'Salesforce DX Developer Guide', url: 'https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_setup_intro.htm' },
      TRAILHEAD,
    ],
  },
  'package-strategy': {
    title: 'Unlocked packages & modular structure',
    summary:
      'Decompose the org into unlocked packages aligned to functional domains, each with a clear dependency direction (no cycles). Packages give versioning, clean install/upgrade, and ownership boundaries. Start with a small number of coarse packages; split as ownership and dependencies clarify. Keep a base/common package for shared components.',
    docs: [
      { label: 'SFDX — Unlocked Packages', url: 'https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_unlocked_pkg_intro.htm' },
      TRAILHEAD,
    ],
  },
  'profiles-vs-permission-sets': {
    title: 'Profiles vs Permission Sets',
    summary:
      'Modern best practice: keep profiles minimal (login hours, default record types, page layouts as needed) and grant capabilities via Permission Sets and Permission Set Groups. This avoids "profile proliferation", makes access additive and auditable, and lets you assign least-privilege bundles per role. Salesforce is moving permissions toward permission sets.',
    docs: [HELP, TRAILHEAD],
  },
  'owd-sharing-model': {
    title: 'OWD & the sharing model (greenfield)',
    summary:
      'Set Org-Wide Defaults to the most restrictive level each object needs (Private / Public Read Only / Public Read-Write), then OPEN UP access with the role hierarchy, sharing rules (ownership- or criteria-based), permission sets (View All/Modify All), teams, and manual/Apex sharing. Design least-privilege: start Private and grant deliberately. Plan sharing recalculation cost for large data volumes.',
    docs: [HELP, TRAILHEAD],
  },
  'standard-vs-custom-objects': {
    title: 'Standard vs custom objects',
    summary:
      'Use standard objects (Account, Contact, Opportunity, Case, Lead, ...) whenever they fit — they come with built-in features, reports, and integrations. Create custom objects only for concepts standard objects do not represent. Prefer extending a standard object with custom fields over cloning it. Consider the data model, relationships, and license implications before adding custom objects.',
    docs: [HELP, TRAILHEAD],
  },
  'naming-conventions': {
    title: 'Naming & documentation conventions',
    summary:
      'Establish conventions from day one: consistent API names (PascalCase objects, clear field suffixes), prefixes for app/domain, description + help-text on every field, and a documented automation/trigger naming scheme. Conventions make the org self-describing and reduce technical debt. Record them in a living standards doc.',
    docs: [TRAILHEAD, HELP],
  },
  'sandbox-environment-strategy': {
    title: 'Sandbox & environment strategy',
    summary:
      'Use a tiered environment path: developer/scratch orgs for build, an integration/partial sandbox for merged work, a full or partial sandbox for UAT/staging, then production. Match sandbox type to need (Developer/Developer Pro for config/code, Partial/Full for data-dependent testing). Automate refresh + seeding and gate promotion with CI tests.',
    docs: [HELP, TRAILHEAD],
  },
  'single-vs-multi-org': {
    title: 'Single-org vs multi-org strategy',
    summary:
      'Prefer a single org when business units share processes, data, and customers — it maximizes the 360° view and minimizes integration/duplication cost. Choose multi-org when regulatory isolation, radically different processes, divestiture risk, or per-region governance demand hard boundaries. Weigh org limits, governance maturity, and the cost of cross-org integration before splitting.',
    docs: [{ label: 'Architect decision guides', url: 'https://architect.salesforce.com/decision-guides' }, TRAILHEAD],
  },
  'data-retention-archiving': {
    title: 'Data retention & archiving strategy',
    summary:
      'Plan retention up front: classify data by regulatory/operational need, define how long each object is kept hot, and archive or purge the rest. Options include Big Objects for low-cost archival, scheduled batch purges, external/offline archives, and field-history/event-log retention settings. Designing this early prevents storage-limit and LDV pain later.',
    docs: [HELP, TRAILHEAD],
  },
  'large-data-volumes': {
    title: 'Large data volumes (LDV) planning',
    summary:
      'At millions of records, design for selectivity: indexed/selective filters, skinny tables (via Support) for hot reports, careful sharing (ownership/data skew avoidance), Big Objects for archival, and bulk/async data loads. Watch for non-selective SOQL, account/ownership skew, and sharing-recalculation cost. Plan partitioning and reporting strategy before volume arrives.',
    docs: [{ label: 'LDV Best Practices (Architects)', url: 'https://architect.salesforce.com/well-architected/adaptable/resilient' }, TRAILHEAD],
  },
  'release-management': {
    title: 'Release management & deployment pipeline',
    summary:
      'Establish a source-of-truth VCS, environment promotion path (dev → integration → UAT → prod), and a CI/CD pipeline that validates + runs Apex tests on every change and deploys on merge. Use unlocked packages or change sets/metadata API, automate with the `sf` CLI or a DevOps tool, and keep deployments small and frequent. Gate prod with required coverage + review.',
    docs: [TRAILHEAD, { label: 'Salesforce DX Developer Guide', url: 'https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_setup_intro.htm' }],
  },
  'well-architected': {
    title: 'Salesforce Well-Architected principles',
    summary:
      'Salesforce Well-Architected frames a healthy org as Trusted (secure, compliant, reliable), Easy (intentional, automated, resilient — minimal complexity/debt), and Adaptable (composable, scalable). Use it as a checklist when designing: least-privilege security, consolidated automation, documented conventions, modular packaging, and scalable data design.',
    docs: [{ label: 'Salesforce Well-Architected', url: 'https://architect.salesforce.com/well-architected/overview' }, TRAILHEAD],
  },
  'license-types': {
    title: 'License types & planning',
    summary:
      'Match license types to user needs: full Salesforce/CRM licenses for internal power users, Platform licenses for users who only need custom apps + a few standard objects, and Experience Cloud licenses for external community users. Permission Set Licenses add capabilities on top. Count licenses by persona early — they drive cost and constrain object/feature access.',
    docs: [HELP, TRAILHEAD],
  },
  'integration-patterns': {
    title: 'Integration patterns',
    summary:
      'Pick the pattern by need: Request-Reply (synchronous UI callouts), Fire-and-Forget (Platform Events / outbound), Batch Data Sync (scheduled bulk), Remote Call-In (inbound REST/SOAP API), and UI Update from external (streaming/CDC). Prefer middleware/event-driven over point-to-point at scale; use Named Credentials for auth and design idempotent retries + error handling.',
    docs: [{ label: 'Integration Patterns (Architects)', url: 'https://architect.salesforce.com/decision-guides/integrate-salesforce' }, TRAILHEAD],
  },
});

/**
 * Resolve a free-text topic argument to a known topic key. Exact key match
 * first, then a loose contains-match on key or title so the router's
 * `suggestedArgs.topic` and a user's phrasing both land. Returns null when
 * nothing matches confidently (the tool then lists available topics).
 */
export const resolveTopicKey = (topic: string): string | null => {
  const t = topic.trim().toLowerCase();
  if (t.length === 0) return null;
  const keys = Object.keys(KNOWLEDGE_TOPICS);
  if (keys.includes(t)) return t;
  const hit = keys.find(
    (k) =>
      k.includes(t) ||
      t.includes(k) ||
      KNOWLEDGE_TOPICS[k]!.title.toLowerCase().includes(t),
  );
  return hit ?? null;
};
