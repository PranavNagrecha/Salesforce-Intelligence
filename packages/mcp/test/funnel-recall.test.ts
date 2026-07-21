/// <reference types="vitest/globals" />

/**
 * WF-04: a PRODUCT-repo funnel-recall guard so GitHub CI (which runs only this
 * repo, not the local-only sf-intelligence-qa harness) catches funnel regressions.
 * The harness has the full router-recall + 1000-question generalization evals; this
 * is a small representative subset that runs in `pnpm -r test`. Asserts the correct
 * tool family is in the funnel's top-8 for each question, above a conservative floor
 * — a regression tripwire, not a tight bar.
 */
import { semanticCandidates } from '../src/semantic-funnel.js';

// Representative real-user questions (generic SF objects — no org data) → the tool
// family that should appear in the funnel's top-8. Phrasings vary on purpose.
const CASES: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
  { q: 'who is able to modify the Amount field on Opportunity', anyOf: ['sfi.field_access_audit', 'sfi.crud_fls_audit', 'sfi.who_can_access_object'] },
  { q: 'why can this rep not open the case record', anyOf: ['sfi.why_cant_user_see_record', 'sfi.interpret'] },
  { q: 'spell out what the Marketing profile is allowed to do', anyOf: ['sfi.effective_permissions', 'sfi.permission_risk_report'] },
  { q: 'which permission sets are assigned to nobody', anyOf: ['sfi.unassigned_permission_sets'] },
  { q: 'give me the sharing picture for the Account object', anyOf: ['sfi.generate_sharing_summary', 'sfi.interpret'] },
  { q: 'what falls over if I delete the Discount field', anyOf: ['sfi.get_impact', 'sfi.safe_to_delete_field', 'sfi.field_lineage', 'sfi.interpret'] },
  { q: 'is it safe to switch off the renewal flow', anyOf: ['sfi.what_if_deactivate_flow', 'sfi.get_impact', 'sfi.interpret'] },
  { q: 'every reference to the SSN field anywhere', anyOf: ['sfi.find_component_usages', 'sfi.find_field_anywhere', 'sfi.find_code_usages'] },
  { q: 'what fires when an account gets saved', anyOf: ['sfi.order_of_execution', 'sfi.what_happens_on_save'] },
  { q: 'map the call graph of the payment processor class', anyOf: ['sfi.call_graph', 'sfi.downstream_effects'] },
  { q: 'where might we blow a governor limit', anyOf: ['sfi.governor_limit_risks'] },
  { q: 'find dead apex nobody calls', anyOf: ['sfi.find_dead_code', 'sfi.unused_components', 'sfi.find_apex_usages'] },
  { q: 'what outside systems does this org talk to', anyOf: ['sfi.integration_map', 'sfi.endpoint_catalog'] },
  { q: 'list every outbound endpoint', anyOf: ['sfi.endpoint_catalog', 'sfi.integration_map', 'sfi.outbound_message_catalog'] },
  { q: 'write an admin handbook for this org', anyOf: ['sfi.generate_admin_handbook', 'sfi.generate_onboarding_doc', 'sfi.org_overview'] },
  { q: 'where does this org keep personal data', anyOf: ['sfi.pii_inventory', 'sfi.generate_compliance_report'] },
  { q: 'how much technical debt is in here', anyOf: ['sfi.tech_debt_score', 'sfi.org_risk_report'] },
  { q: 'is our security posture getting better or worse across refreshes', anyOf: ['sfi.trend'] },
  { q: 'is my local copy of the org current', anyOf: ['sfi.health_check', 'sfi.live_stale_check', 'sfi.org_pulse'] },
  { q: 'give me a tour of this org', anyOf: ['sfi.org_overview', 'sfi.org_card'] },
  { q: 'how many open opportunities do we have', anyOf: ['sfi.live_count'] },
  { q: 'show me a handful of lead records', anyOf: ['sfi.live_sample'] },
  { q: 'which paid licenses sit unused', anyOf: ['sfi.live_license_usage'] },
  { q: 'what does the Industry field actually mean', anyOf: ['sfi.explain_field', 'sfi.field_meaning'] },
  { q: 'walk me through what the onboarding flow does', anyOf: ['sfi.explain_flow'] },
  { q: 'who subscribes to the order event', anyOf: ['sfi.event_subscribers', 'sfi.cdc_subscribers'] },
  { q: 'which apex classes ship without test coverage', anyOf: ['sfi.test_coverage_gaps', 'sfi.meaningful_test_audit', 'sfi.list_components', 'sfi.apex_test_coverage'] },
  { q: 'where does Pranav have access to', anyOf: ['sfi.field_access_audit', 'sfi.who_can_access_object', 'sfi.object_access_audit', 'sfi.effective_permissions', 'sfi.why_cant_user_see_record'] },
  { q: 'what changed since last month', anyOf: ['sfi.changed_since', 'sfi.org_history', 'sfi.what_changed_since_refresh', 'sfi.component_history'] },
  // F3 — the advertised OBJECT reasoning questions. interpret is an accepted
  // complement in each anyOf (it is stacked onto these object-anchored intents),
  // but the primary specialist is what the floor actually guards.
  { q: 'who can access the Account object records', anyOf: ['sfi.who_can_access_object', 'sfi.object_access_audit', 'sfi.interpret'] },
  { q: 'do two automations overwrite the same field on Account', anyOf: ['sfi.automation_collisions', 'sfi.automation_risk_report', 'sfi.interpret'] },
  { q: 'why did my save abort with that status code', anyOf: ['sfi.explain_error', 'sfi.what_happens_on_save', 'sfi.interpret'] },
  // Junction/join detection is object-anchored reasoning — interpret is the tool
  // that answers it (no separate specialist), and it is IN the funnel top-8.
  { q: 'is this a junction object linking two others', anyOf: ['sfi.interpret'] },
  { q: 'what makes Event_Attendee__c a junction object, and what happens if either parent is deleted?', anyOf: ['sfi.interpret'] },
  // Async-boundary reasoning (RM-reason async): "does this Apex run async / is its
  // effect deferred?" — interpret carries the async-boundary concept, and the async
  // specialist async_chain_depth is an accepted complement; both are in the top-8.
  { q: 'is this apex async so its effect is deferred', anyOf: ['sfi.interpret', 'sfi.async_chain_depth'] },
  { q: 'does NightlyRecalcBatch run in the same transaction as its caller, and can the caller see its writes?', anyOf: ['sfi.interpret'] },
  { q: 'does NightlyRecalcScheduler run in the same transaction as the code that schedules it?', anyOf: ['sfi.interpret'] },
  // Apex-sharing-mode reasoning (RM-reason apex-sharing-mode): the CLASS-LEVEL
  // with/without/inherited sharing DECLARATION is uniquely carried by interpret —
  // generate_sharing_summary is object-OWD, explain_apex_method is method-body, and
  // crud_fls_audit is FLS/CRUD; none reason about the sharing declaration posture.
  // A genuine hit (interpret rank ~4 in the top-8), not a floor-pad by a specialist.
  { q: 'is this apex class with sharing or without sharing', anyOf: ['sfi.interpret'] },
  // System-context-external-surface reasoning (compound): the INTERSECTION of
  // without-sharing AND externally-reachable is the security-review priority
  // interpret carries deterministically — no single specialist reasons about the
  // conjunction (generate_sharing_summary is object-OWD, endpoint_catalog is the
  // surface only, crud_fls_audit is FLS/CRUD). A genuine hit (interpret rank 1 in
  // the top-8), not a floor-pad by a specialist.
  { q: 'is this apex class both without sharing and exposes an external api', anyOf: ['sfi.interpret'] },
  { q: 'what are the security implications of AccountTableController?', anyOf: ['sfi.interpret'] },
  { q: 'contact has many active record-triggered flows — is their execution order deterministic, and what is the risk?', anyOf: ['sfi.interpret'] },
  { q: 'why could a Contact save fail, and which automations could be involved?', anyOf: ['sfi.interpret'] },
];

const FLOOR = 0.78; // conservative tripwire; the harness tracks the precise bar

describe('funnel recall (CI guard)', () => {
  const hits = CASES.filter(({ q, anyOf }) => {
    const tools = semanticCandidates(q, 8).map((c) => c.tool);
    return tools.some((t) => anyOf.includes(t));
  });

  it(`keeps recall@8 above the floor on representative questions`, () => {
    const recall = hits.length / CASES.length;
    // Helpful failure message: which questions slipped.
    if (recall < FLOOR) {
      const misses = CASES.filter(
        ({ q, anyOf }) => !semanticCandidates(q, 8).map((c) => c.tool).some((t) => anyOf.includes(t)),
      ).map((c) => c.q);
      throw new Error(`funnel recall ${(100 * recall).toFixed(1)}% < ${100 * FLOOR}% floor. Misses: ${misses.join(' | ')}`);
    }
    expect(recall).toBeGreaterThanOrEqual(FLOOR);
  });

  it('returns nothing for gibberish (no false candidates)', () => {
    expect(semanticCandidates('zxqw plkj vbnm', 8)).toEqual([]);
  });
});

/**
 * router-v2 P3 — blind-spot phrasings. SYNTHETIC analogs (generic entities
 * only) of the labeled funnel-blind misses from the 2K eval diagnosis, biased
 * toward the top gap families: search_components / find_component_usages /
 * list_components / resolve / explain_flow / what_happens_on_save /
 * effective_permissions. Each gold tool must be IN the top-8 (candidate
 * recall — the host LLM makes the final pick). These pass because of the
 * utterance corpus (funnel-utterances.ts) + weighted synonym expansion; a
 * corpus or synonym-table edit that drops one is a real recall regression.
 */
const BLIND_SPOTS: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
  // search_components — existence checks phrased as yes/no behavior questions
  { q: 'is there a validation rule that stops me from saving a Contact without a phone number', anyOf: ['sfi.search_components', 'sfi.list_components'] },
  { q: 'do we have a duplicate rule on Contact', anyOf: ['sfi.search_components', 'sfi.list_components', 'sfi.live_duplicate_check'] },
  { q: 'is there an approval process on Opportunity', anyOf: ['sfi.search_components', 'sfi.list_components'] },
  // find_component_usages — "who has this perm set" + "what references this"
  { q: 'who has the Invoice Manager permission set assigned', anyOf: ['sfi.find_component_usages'] },
  { q: 'what references the Invoice Manager permission set', anyOf: ['sfi.find_component_usages'] },
  { q: 'does anything still use the Discount component', anyOf: ['sfi.find_component_usages'] },
  // list_components — informal full-enumeration asks
  { q: 'give me the whole field list on Account', anyOf: ['sfi.list_components'] },
  { q: 'what record types exist on Case', anyOf: ['sfi.list_components', 'sfi.recordtype_availability'] },
  // resolve — fuzzy / conceptual lookups that never say "resolve"
  { q: 'find me the field that stores the customer tier', anyOf: ['sfi.resolve', 'sfi.find_semantic_field'] },
  { q: 'look up the thing called something like case assignment', anyOf: ['sfi.resolve'] },
  // explain_flow — "walk me through / break down" a named flow
  { q: 'break down the Case_Escalation flow for me', anyOf: ['sfi.explain_flow'] },
  { q: 'walk me through what the renewal flow creates and updates', anyOf: ['sfi.explain_flow'] },
  // what_happens_on_save — save cascade + record-lock collision diagnosis
  { q: 'what runs behind the scenes when I save an Opportunity', anyOf: ['sfi.what_happens_on_save', 'sfi.order_of_execution'] },
  { q: 'we keep hitting record lock errors when saving Cases', anyOf: ['sfi.what_happens_on_save', 'sfi.order_of_execution'] },
  // effective_permissions — union-of-grants + error-message-driven asks
  { q: 'what can the Support profile actually do once you combine its permission sets', anyOf: ['sfi.effective_permissions'] },
  { q: "the update failed with 'missing Edit permission' — whose perm is that", anyOf: ['sfi.effective_permissions', 'sfi.field_access_audit'] },
  // secondary gap families from the same diagnosis
  { q: 'i keep seeing acme__ everywhere — what is that prefix', anyOf: ['sfi.installed_package_catalog', 'sfi.package_impact', 'sfi.resolve'] },
  { q: 'which flows write to the Status field on Case', anyOf: ['sfi.why_field_changed', 'sfi.field_provenance', 'sfi.interpret'] },
  { q: 'are there any dependency loops between our triggers', anyOf: ['sfi.find_dependency_cycles'] },
  { q: 'what is the blast radius of changing the Amount field type', anyOf: ['sfi.what_if_change_field_type', 'sfi.get_impact', 'sfi.blast_radius_live'] },
  { q: 'how entangled are we with the acme package if we uninstall it', anyOf: ['sfi.package_impact', 'sfi.installed_package_catalog'] },
];

describe('funnel recall — blind-spot phrasings (router-v2 P3)', () => {
  it.each(BLIND_SPOTS)('puts the gold tool in the top-8 for: $q', ({ q, anyOf }) => {
    const tools = semanticCandidates(q, 8).map((c) => c.tool);
    expect(
      tools.some((t) => anyOf.includes(t)),
      `expected one of [${anyOf.join(', ')}] in top-8, got: ${tools.join(', ')}`,
    ).toBe(true);
  });
});

/**
 * REASONING-SEMANTIC-FUNNEL-REAL-PHRASING-GAPS — natural consequence questions
 * whose everyday wording ("writes visible", "record visibility", "trigger
 * phase", "status code") was captured by broad specialists before `sfi.interpret`
 * (the deterministic reasoning surface) entered the funnel top-8. These are the
 * finding's four fixtures, anonymized (established placeholder NightlyRecalcBatch
 * + standard Account/Asset/Case — no org identifiers). EACH missed interpret in
 * the top-8 before the funnel-utterances corpus fix and reaches it now; a per-row
 * assertion so any single regression (a corpus edit that drops one below rank 8)
 * goes red, not just an aggregate-floor dip.
 */
const REASONING_REACH: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
  // (1) async-boundary + write-visibility of a batch/queueable. async_chain_depth
  // is an accepted complement (the async specialist), consistent with the async
  // CASES above; interpret carries the grounded batchable + dispatch reasoning.
  { q: 'Does NightlyRecalcBatch enqueue more asynchronous work, and when are its writes visible?', anyOf: ['sfi.interpret', 'sfi.async_chain_depth'] },
  // (2) Controlled by Parent OWD → record visibility.
  { q: 'What does Controlled by Parent mean for Asset record visibility?', anyOf: ['sfi.interpret'] },
  // (3) multiple active flows sharing one trigger phase → ordering risk.
  { q: 'Do multiple active flows on Account share a trigger phase, and what ordering risk follows?', anyOf: ['sfi.interpret'] },
  // (4) a save failed with a status code → which configured automations.
  { q: 'A Case save failed with a status code. Which configured automations are plausible sources?', anyOf: ['sfi.interpret'] },
];

describe('funnel recall — reasoning-surface reachability (REASONING-SEMANTIC-FUNNEL-REAL-PHRASING-GAPS)', () => {
  it.each(REASONING_REACH)('reaches the reasoning tool in the top-8 for: $q', ({ q, anyOf }) => {
    const tools = semanticCandidates(q, 8).map((c) => c.tool);
    expect(
      tools.some((t) => anyOf.includes(t)),
      `expected one of [${anyOf.join(', ')}] in top-8, got: ${tools.join(', ')}`,
    ).toBe(true);
  });
});

/**
 * ROUTE-MISSES-SHIPPED-MULTIPLICITY-CONCEPT — the SHIPPED reasoning concepts
 * `concept:apex-trigger-per-object-multiplicity` (RM-C3) and the scheduled-path /
 * async family (`concept:flow-scheduled-path-post-commit-fault`,
 * `concept:flow-platform-event-triggered-async`) FIRE on the oracle, but the
 * funnel never ranked `sfi.interpret` for their natural COUNT / undefined-order /
 * after-commit-fault / platform-event wording — so the reasoning never reached
 * the host. Additive gold rows (generic placeholders + standard Account/Contact
 * only) proving interpret is now reachable in the top-8 for each family. Each of
 * these missed interpret entirely before the funnel-utterances corpus fix; a
 * corpus edit that drops one back below rank 8 is a real recall regression.
 */
const MULTIPLICITY_AND_SCHEDULED_PATH_REACH: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
  // (a) apex-trigger-per-object-multiplicity — count + undefined-order wording.
  { q: 'How many active Apex triggers fire on Contact, and is their order undefined?', anyOf: ['sfi.interpret'] },
  { q: 'does this object have more than one active Apex trigger, so their order is undefined?', anyOf: ['sfi.interpret'] },
  { q: 'several active Apex triggers on Account fire on the same event — is their execution order guaranteed?', anyOf: ['sfi.interpret'] },
  // (b) flow-scheduled-path-post-commit-fault — async scheduled path after commit.
  { q: 'a scheduled path runs asynchronously after the record commits — can it roll back the original save?', anyOf: ['sfi.interpret'] },
  { q: 'this flow has a scheduled path that runs after commit — what fault handling risk does that create?', anyOf: ['sfi.interpret'] },
  // (c) flow-platform-event-triggered-async — platform-event-triggered flow.
  { q: 'is this flow platform-event triggered, and what does that imply for the transaction?', anyOf: ['sfi.interpret'] },
];

describe('funnel recall — shipped multiplicity + scheduled-path reasoning reachability (ROUTE-MISSES-SHIPPED-MULTIPLICITY-CONCEPT)', () => {
  it.each(MULTIPLICITY_AND_SCHEDULED_PATH_REACH)('reaches sfi.interpret in the top-8 for: $q', ({ q, anyOf }) => {
    const tools = semanticCandidates(q, 8).map((c) => c.tool);
    expect(
      tools.some((t) => anyOf.includes(t)),
      `expected one of [${anyOf.join(', ')}] in top-8, got: ${tools.join(', ')}`,
    ).toBe(true);
  });

  // The finding's ACCEPTANCE bar is stricter than reachability: the Contact-shaped
  // multiplicity question (with the undefined-order cue) must rank sfi.interpret
  // in the TOP-5, not merely the top-8.
  it('ranks sfi.interpret in the top-5 for the acceptance question (undefined trigger order)', () => {
    const top5 = semanticCandidates(
      'How many active Apex triggers fire on Contact, and is their order undefined?',
      5,
    ).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * ROUTE-UNDER-RANKS-SHIPPED-SCHEDULED-PATH-CONCEPT — the shipped
 * `concept:flow-scheduled-path-post-commit-fault` fired via interpret, but for the
 * NAMED-flow "does <Flow> run after the save commits in a separate transaction?"
 * phrasing interpret was present-not-primary (what_happens_on_save led). The
 * acceptance is STRICTER than reachability: interpret must rank in the TOP-2 for
 * the async-after-commit / separate-transaction wording. Generic placeholders /
 * standard objects only.
 */
const SCHEDULED_PATH_TOP2: readonly string[] = [
  'does this flow run after the save commits, in a separate transaction from the save?',
  'this flow uses an asynchronous after-commit scheduled path — does it run outside the save transaction?',
  'does the scheduled path on this flow run after the commit so it cannot roll back the save?',
];

describe('funnel ranking — async-after-commit scheduled path ranks interpret top-2 (ROUTE-UNDER-RANKS-SHIPPED-SCHEDULED-PATH-CONCEPT)', () => {
  it.each(SCHEDULED_PATH_TOP2)('ranks sfi.interpret in the top-2 for: %s', (q) => {
    const top2 = semanticCandidates(q, 2).map((c) => c.tool);
    expect(top2, `top-2 was: ${top2.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Lane R — C1 PE/async acceptance: platform-event Flow + Automated Process
 * phrasing must rank sfi.interpret in the top-5 for flow-platform-event-triggered-async
 * and apex-trigger-platform-event-async reasoning.
 */
describe('funnel ranking — platform-event async ranks interpret top-5 (Arc-2 C1 PE)', () => {
  it('ranks sfi.interpret in the top-5 for the acceptance question', () => {
    const top5 = semanticCandidates(
      'Does this platform-event Flow run async as Automated Process?',
      5,
    ).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Lane R — C1 A2 acceptance: external-id / unique-field duplicate-value
 * phrasing must rank sfi.interpret in the top-5 for unique-field-constraint and
 * external-id-field reasoning.
 */
describe('funnel ranking — external id duplicate-value ranks interpret top-5 (Arc-2 C1 A2)', () => {
  it('ranks sfi.interpret in the top-5 for the acceptance question', () => {
    const top5 = semanticCandidates(
      'Can two records share this External Id?',
      5,
    ).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Lane Docs — Wave 2/3/4 NL hooks. Six concept families whose natural
 * consequence wording must rank sfi.interpret in the top-5 once routing utterances
 * ship (concepts may land in parallel on concept lanes). Generic placeholders only.
 */
const ARC2_WAVE234_TOP5: readonly string[] = [
  // A15 object-crud-grant-layer
  'Is object-level Read permission table-level only — does it not by itself grant record visibility?',
  // A20 duplicate-rule-blocks-save
  'Can a duplicate rule set to Block fail the save when a matching record exists?',
  // B2 territory-sharing-rule
  'Does this territory sharing rule grant access based on the user\'s territory assignment?',
  // B4 scoping-rule-not-security
  'Is an active scoping rule just a default record scope, not a security boundary?',
  // B22 flow-inactive-dead-automation
  'Does a Draft or Obsolete flow ever run during save — should it be excluded from save order?',
  // B18 login-hours-restriction
  'Does this profile block login outside its configured login hours window?',
  // EC-6 / C11 recursive-automation-self-write
  'Does this flow write fields on the same object it triggers on — can it re-enter the save order?',
  // Arc-2 Track Funnel DoD — C8–C12 + D5 (recently shipped concept families)
  // C8 / EC-4 formula-on-derived
  'is a formula referencing another formula field a second-order derivation per the concept model?',
  // C9 / EC-13 rollup-recalc-source-coupling
  'which child relationship field does this roll-up summary aggregate from?',
  // C10 / EC-5 cross-phase-write-invisibility
  'can a validation rule ever observe a field value written by an after-save flow on the same save?',
  // C12 / EC-7 mixed-dml-setup-vs-nonsetup
  'does this Apex class write to User in the same transaction as business object DML, risking MIXED_DML_OPERATION?',
  // D5 field-history-tracking-20-field-limit
  'does this object structurally imply it is at the 20-field field history tracking cap?',
];

describe('funnel ranking — Wave 2/3/4 concept families rank interpret top-5 (Arc-2 Lane Docs)', () => {
  it.each(ARC2_WAVE234_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD wave 2 — C13/C15/C17 + D1/D2 NL hooks. Five concept
 * families whose natural consequence wording must rank sfi.interpret in the top-5
 * once routing utterances ship (EC-8 anti-join unlocks C15/C17; EC-4 ships
 * C13/D1/D2). Generic placeholders only.
 */
const ARC2_FUNNEL_DOD2_TOP5: readonly string[] = [
  // C15 / EC-8 crud-fls-consistency-anti-join
  'is field-level Edit on a custom field without matching object Edit on its parent object an inert permission grant?',
  // C17 / EC-8 deep-creation-gap
  'is a required field with no default a hard creation blocker when no before-save automation writes it?',
  // C13 / EC-4 queueable-chain-depth
  'when one Queueable dispatches another Queueable, does each hop run in its own transaction?',
  // D1 / EC-4 future-invoked-from-async-illegal
  'is calling an @future method from a Batch class illegal at runtime?',
  // D2 / EC-4 validation-gates-on-rollup-recalculated-later
  'does a validation rule on a roll-up summary field test the pre-save aggregate?',
];

describe('funnel ranking — Arc-2 Funnel DoD wave 2 concept families rank interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD2_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — C16 NL hook (EC-9 set-difference). Natural
 * consequence wording for permission-set-group-muting-calculation was owned
 * by broad specialists (effective_permissions, what_if_assign_permset,
 * live_permset_holders) so interpret never reached top-5 until routing
 * utterances shipped. Generic placeholders only.
 */
const ARC2_FUNNEL_DOD_C16_TOP5: readonly string[] = [
  // C16 / EC-9 permission-set-group-muting-calculation
  'what does the reasoning engine conclude about muting calculation when a permission set group has both members and muting sets?',
];

describe('funnel ranking — Arc-2 Funnel DoD C16 ranks interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_C16_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — D3 NL hooks (EC-11 crossObjectCascade). cross-object-
 * cascade-save FIRES on the oracle, but natural consequence wording was owned by
 * broad specialists (what_happens_on_save, order_of_execution, governor_limit_risks)
 * so interpret never reached top-5 until routing utterances shipped. Generic
 * placeholders / standard objects only.
 */
const ARC2_FUNNEL_DOD_D3_TOP5: readonly string[] = [
  // D3 / EC-11 cross-object-cascade-save
  'If automation on one object writes another object, does that trigger the target object\'s full save order?',
];

describe('funnel ranking — Arc-2 Funnel DoD D3 ranks interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_D3_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — D4/D7 NL hooks (EC-11 dualEdge sameObject:false +
 * isEmpty). before-save-flow-cross-record-write and profile-ip-restriction-
 * absence FIRE on the oracle, but natural consequence wording was owned by
 * broad specialists so interpret never reached top-5 until routing utterances
 * shipped. Generic placeholders / standard objects only.
 */
const ARC2_FUNNEL_DOD_D4D7_TOP5: readonly string[] = [
  // D4 / EC-11 before-save-flow-cross-record-write
  'Does this before-save flow write to a different object than the one it triggers on?',
  // D7 / EC-11 profile-ip-restriction-absence (empty loginIpRanges)
  'Does this profile have empty login IP ranges so users can log in from any IP?',
];

describe('funnel ranking — Arc-2 Funnel DoD D4/D7 rank interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_D4D7_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — D8/C18 NL hooks (EC-12 propertyCompare +
 * EC-10 fieldJoin orphan set-diff). external-owd-exceeds-internal and
 * dependent-picklist-orphaned-value FIRE on the oracle, but natural
 * consequence wording was owned by broad specialists so interpret never
 * reached top-5 until routing utterances shipped. Generic placeholders /
 * standard objects only.
 */
const ARC2_FUNNEL_DOD_D8C18_TOP5: readonly string[] = [
  // D8 / EC-12 external-owd-exceeds-internal
  'Is the external organization-wide default more permissive than the internal OWD on this object?',
  // C18 / EC-10 dependent-picklist-orphaned-value
  'Does this dependent picklist reference a controlling value that is no longer active on the controlling field?',
];

describe('funnel ranking — Arc-2 Funnel DoD D8/C18 rank interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_D8C18_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — D9 NL hooks (property-equals-endpoint).
 * flow-self-dml-reentry FIRES on the oracle, but natural re-entry wording was
 * owned by order_of_execution / explain_flow so interpret never reached top-5
 * until routing utterances shipped. Generic placeholders only.
 */
const ARC2_FUNNEL_DOD_D9_TOP5: readonly string[] = [
  "Can this flow's DML on its own trigger object cause the flow to re-enter?",
];

describe('funnel ranking — Arc-2 Funnel DoD D9 rank interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_D9_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track C19 — bulkification-gap-in-trigger-reachable NL hooks. Natural
 * consequence wording for trigger-reachable loop SOQL/DML amplification was
 * owned by broad specialists (governor_limit_risks, code_quality_audit) so
 * interpret never reached top-5 until routing utterances shipped. Generic
 * placeholders / standard objects only.
 */
const ARC2_FUNNEL_DOD_C19_TOP5: readonly string[] = [
  'is in-loop SOQL or DML in a class reachable from a trigger amplified to 200 rows?',
  'does this trigger call Apex that queries or writes inside a loop, risking governor limits on a bulk load?',
  'when a trigger invokes a handler with SOQL in a loop, is the governor limit risk amplified across up to 200 records?',
  'is loop-based SOQL or DML in a class called by this trigger a bulkification gap at trigger scale?',
  'does this Apex trigger reach a class with dml-in-loop or soql-in-loop, so the anti-pattern scales with trigger batch size?',
  'can a trigger that calls a non-bulkified Apex handler fail with a LimitException under a 200-record import?',
];

describe('funnel ranking — Arc-2 Funnel DoD C19 ranks interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_C19_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * Arc-2 Track Funnel DoD — D10 NL hooks (EC-14 firstMatchOrdinal).
 * assignment-escalation-first-match-ordering FIRES on the oracle, but natural
 * first-match / catch-all / entry-order wording was owned by broad specialists
 * so interpret never reached top-5 until routing utterances shipped.
 */
const ARC2_FUNNEL_DOD_D10_TOP5: readonly string[] = [
  'does this assignment rule evaluate entries top-down so a catch-all entry at the top starves later specific entries?',
  'is the first rule entry a catch-all with no criteria that blocks later assignment rule entries from ever matching?',
  'assignment rule first-match ordering — can an early catch-all entry make later entries unreachable?',
  'when an assignment rule has a catch-all entry first, are later specific entries structurally starved by first-match evaluation?',
  'does entry order on this assignment rule mean a no-criteria row wins before targeted queue rules below it?',
];

describe('funnel ranking — Arc-2 Funnel DoD D10 rank interpret top-5', () => {
  it.each(ARC2_FUNNEL_DOD_D10_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * ARC-2 concept-expansion — NL hooks for the three new pure-YAML NODE concepts
 * (validation-rule-inactive, workflow-rule-inactive-dead,
 * picklist-backed-by-global-value-set). Their natural "is this rule inactive /
 * is this picklist global" wording was owned by broad audit / field specialists
 * so interpret never reached top-5 until routing utterances shipped. Generic
 * placeholders / standard objects only.
 */
const ARC2_CONCEPT_EXP_VALIDATION_INACTIVE_TOP5: readonly string[] = [
  'is this validation rule inactive, so it never blocks a save or shows its error message?',
  'this validation rule is deactivated — does it still enforce its constraint or is it dead?',
  'does an inactive validation rule still run in the save order, or can it never fire?',
  'which validation rules are turned off and therefore never enforce their error condition?',
];
describe('funnel ranking — Arc-2 concept-expansion validation-rule-inactive ranks interpret top-5', () => {
  it.each(ARC2_CONCEPT_EXP_VALIDATION_INACTIVE_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

const ARC2_CONCEPT_EXP_WORKFLOW_INACTIVE_TOP5: readonly string[] = [
  'is this workflow rule inactive, so its field updates and email alerts never fire?',
  'this workflow rule is deactivated — is it dead legacy automation that no longer runs on save?',
  'does an inactive workflow rule still perform field updates, or has it stopped firing entirely?',
  'which workflow rules are inactive and therefore never run their actions?',
];
describe('funnel ranking — Arc-2 concept-expansion workflow-rule-inactive-dead ranks interpret top-5', () => {
  it.each(ARC2_CONCEPT_EXP_WORKFLOW_INACTIVE_TOP5)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * ARC-2 grow-forever funnel — the 8 concept-discovery concepts are now
 * NL-reachable via per-concept CARDS (INTERPRET_CONCEPT_CARDS + semantic-funnel
 * max-over-cards scoring). Each concept card is scored independently, so every
 * utterance ranks sfi.interpret top-5 WITHOUT diluting existing concepts
 * (C16/C18/C19 unchanged — see the grow-forever invariant in semantic-funnel.test.ts).
 */
const ARC2_CARD_FIELD_LONGTEXT_RICHTEXT_NOT_FILTERABLE: readonly string[] = [
  "Can I filter a report on the long text area field on Account?",
  "Why can't I sort a list view by a rich text field?",
  "Is this long text area field usable in a SOQL WHERE clause?",
  "Can I make a long text area field an external id or unique?",
  "Why won't Salesforce let me group by a description field?",
];
describe('funnel ranking — Arc-2 grow-forever card field-longtext-richtext-not-filterable ranks interpret top-5', () => {
  it.each(ARC2_CARD_FIELD_LONGTEXT_RICHTEXT_NOT_FILTERABLE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_DUPLICATE_RULE_BYPASS_SHARING_MATCH: readonly string[] = [
  "Do any of our duplicate rules match against records the running user can't see?",
  "Which duplicate rules bypass sharing when they check for duplicates?",
  "Is there a duplicate rule that runs its duplicate matching in system context?",
  "Could a duplicate rule block my save because of a duplicate I don't have access to?",
  "What does bypass sharing rules mean for duplicate matching on Account?",
  "Show me duplicate rules that ignore the sharing model during matching",
];
describe('funnel ranking — Arc-2 grow-forever card duplicate-rule-bypass-sharing-match ranks interpret top-5', () => {
  it.each(ARC2_CARD_DUPLICATE_RULE_BYPASS_SHARING_MATCH)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_DUPLICATE_RULE_REFERENCES_INACTIVE_MATCHING_RULE: readonly string[] = [
  "Why is my duplicate rule not catching duplicates on Account?",
  "Why do duplicate records still save even though I have a duplicate rule enabled?",
  "Is my duplicate rule actually doing anything if its matching rule is inactive?",
  "What happens when a duplicate rule points at a matching rule that isn't active?",
  "Does deactivating a matching rule silently break duplicate detection?",
  "My duplicate rule looks active but duplicates keep getting created \u2014 why?",
];
describe('funnel ranking — Arc-2 grow-forever card duplicate-rule-references-inactive-matching-rule ranks interpret top-5', () => {
  it.each(ARC2_CARD_DUPLICATE_RULE_REFERENCES_INACTIVE_MATCHING_RULE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_APPROVAL_PROCESS_FINAL_LOCK_RECORD_READONLY: readonly string[] = [
  "Which approval processes lock the record after final approval?",
  "Does getting this record approved make it read-only?",
  "Why does automation fail to update a record after it's been approved?",
  "What leaves a record locked once an approval process finishes?",
  "Will a rejected record stay locked from further edits until someone unlocks it?",
  "Does this approval process leave the record read-only after it completes?",
];
describe('funnel ranking — Arc-2 grow-forever card approval-process-final-lock-record-readonly ranks interpret top-5', () => {
  it.each(ARC2_CARD_APPROVAL_PROCESS_FINAL_LOCK_RECORD_READONLY)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_RECORD_TYPE_INACTIVE: readonly string[] = [
  "What does it mean that this record type is inactive?",
  "If a record type is deactivated, can new records still be assigned to it?",
  "Does an inactive record type still route a page layout or business process to new records?",
  "This record type has its active flag set to false \u2014 what are the implications?",
  "Can users pick a deactivated record type when creating a record?",
  "What happens to a business process when its record type is inactive?",
];
describe('funnel ranking — Arc-2 grow-forever card record-type-inactive ranks interpret top-5', () => {
  it.each(ARC2_CARD_RECORD_TYPE_INACTIVE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_REMOTE_SITE_SETTING_PROTOCOL_SECURITY_DISABLED: readonly string[] = [
  "does this remote site setting allow insecure http callouts?",
  "which remote site settings have protocol security disabled?",
  "is this remote site setting insecure?",
  "can this org make cleartext http callouts to an allowlisted host?",
  "why would a remote site setting drop the https-only guard on outbound callouts?",
  "are any of our outbound allowlist entries not requiring https?",
];
describe('funnel ranking — Arc-2 grow-forever card remote-site-setting-protocol-security-disabled ranks interpret top-5', () => {
  it.each(ARC2_CARD_REMOTE_SITE_SETTING_PROTOCOL_SECURITY_DISABLED)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_APEX_INTENTIONAL_SYSTEM_MODE_DML: readonly string[] = [
  "Which Apex classes deliberately run DML in system mode and skip the running user's CRUD and field-level security?",
  "What does it imply when a class writes records with an explicit AccessLevel.SYSTEM_MODE argument?",
  "Is there Apex that intentionally opts out of object and field security for a write?",
  "Which classes do a conscious system-context DML bypass rather than an accidental missing check?",
  "Does running DML in SYSTEM_MODE mean field-level security is not enforced for that write?",
];
describe('funnel ranking — Arc-2 grow-forever card apex-intentional-system-mode-dml ranks interpret top-5', () => {
  it.each(ARC2_CARD_APEX_INTENTIONAL_SYSTEM_MODE_DML)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_CARD_DATARAPTOR_FIELD_SECURITY_UNENFORCED: readonly string[] = [
  "Does this DataRaptor bypass field-level security when it reads Account fields?",
  "Which DataRaptors have Check Field Level Security turned off?",
  "Is this OmniStudio data transform a data-exposure risk for fields the user cannot see?",
  "Can this DataRaptor overwrite fields the running user has no edit access to?",
  "Show me DataRaptors that read or write SObject fields without enforcing FLS",
  "Does turning off field-level security on this DataRaptor over-expose Contact data?",
];
describe('funnel ranking — Arc-2 grow-forever card dataraptor-field-security-unenforced ranks interpret top-5', () => {
  it.each(ARC2_CARD_DATARAPTOR_FIELD_SECURITY_UNENFORCED)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

/**
 * ROUTE-INACTIVE-AUTOMATION-WORD-MISBINDS-USERS — a save-failure / automation
 * question that merely contains the word "inactive" (describing a flow /
 * trigger / validation rule) must NOT rank `sfi.live_inactive_users` (inactive
 * USER ACCOUNTS — a login-access roster tool) as the TOP funnel candidate; a
 * genuine inactive-USER-account question (no recent login / dormant seat) STILL
 * must. Proves the fix at the funnel-candidate layer, not just the route.
 */
describe('funnel ranking — inactive-automation must not top-rank live_inactive_users', () => {
  const AUTOMATION_INACTIVE: readonly string[] = [
    "a user reports a record won't save — is an inactive flow or trigger to blame?",
    "an inactive automation is blocking the user's save — which flow or rule?",
    'Case save failed — could an inactive flow or trigger have blocked it?',
    'is an inactive flow or validation rule causing the save to fail for this user?',
  ];
  it.each(AUTOMATION_INACTIVE)('does not top-rank live_inactive_users for: %s', (q) => {
    const top = semanticCandidates(q, 8).map((c) => c.tool);
    expect(top[0], `top-8 was: ${top.join(', ')}`).not.toBe('sfi.live_inactive_users');
  });

  const GENUINE_INACTIVE_USER: readonly string[] = [
    "which users are inactive and haven't logged in recently?",
    'show me inactive Salesforce users',
    "who hasn't logged in in over 90 days?",
  ];
  it.each(GENUINE_INACTIVE_USER)('still top-ranks live_inactive_users for: %s', (q) => {
    const top = semanticCandidates(q, 8).map((c) => c.tool);
    expect(top[0], `top-8 was: ${top.join(', ')}`).toBe('sfi.live_inactive_users');
  });
});

/**
 * ROUTE-MISSES-SHIPPED-{APEX-CODE-QUALITY,FLOW-FAULT-ROLLBACK,TEST-WITHOUT-ASSERTIONS}
 * — five SHIPPED Graph-B reasoning concepts (soql-injection-surface,
 * bulkification-gap, crud-fls-unenforced, flow-fault-path-rollback-gap,
 * test-class-without-assertions) FIRE on the oracle, but their natural
 * code-defect vocabulary was owned by broad specialists so `sfi.interpret` never
 * entered the funnel top-8. Additive gold rows proving interpret is now reachable.
 */
const APEX_CODE_QUALITY_REASONING_REACH: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
  { q: 'Does ApplicationFormService build dynamic SOQL from user input, and is that an injection risk?', anyOf: ['sfi.interpret'] },
  { q: 'Does Close Student Evaluation leave any unhandled fault paths that could roll back the whole transaction?', anyOf: ['sfi.interpret', 'sfi.flow_fault_audit'] },
  { q: 'Does ApplicationPortalTestData have zero meaningful assertions and just inflate coverage?', anyOf: ['sfi.interpret', 'sfi.meaningful_test_audit'] },
];
describe('funnel recall — apex code-quality / flow-fault / test-quality reasoning reachability', () => {
  it.each(APEX_CODE_QUALITY_REASONING_REACH)('reaches sfi.interpret in the top-8 for: $q', ({ q, anyOf }) => {
    const tools = semanticCandidates(q, 8).map((c) => c.tool);
    expect(tools.some((t) => anyOf.includes(t)), `top-8: ${tools.join(', ')}`).toBe(true);
  });
  it.each([
    'Does ApplicationFormService build dynamic SOQL from user input, and is that an injection risk?',
    'Does Close Student Evaluation leave any unhandled fault paths that could roll back the whole transaction?',
  ])('ranks sfi.interpret in the top-5 for: %s', (q) => {
    expect(semanticCandidates(q, 5).map((c) => c.tool)).toContain('sfi.interpret');
  });
});


/**
 * ARC-2 concepts-batch3 — 5 more concepts (3 dataType + 2 revived permset),
 * NL-reachable via grow-forever per-concept cards.
 */
const ARC2_B3_FIELD_CLASSIC_ENCRYPTED_TEXT: readonly string[] = [
  "Is this an encrypted text field, and who can actually see its value?",
  "why is this field showing asterisks to most users?",
  "can I filter or report on a classic encrypted text field?",
  "is this encrypted field usable as an external id or in a formula?",
  "does this masked field hide its value unless you have View Encrypted Data?",
];
describe('funnel ranking — Arc-2 batch3 field-classic-encrypted-text ranks interpret top-5', () => {
  it.each(ARC2_B3_FIELD_CLASSIC_ENCRYPTED_TEXT)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_B3_FIELD_AUTONUMBER_SYSTEM_ASSIGNED_READONLY: readonly string[] = [
  "Can I set this auto number field from the API or Apex?",
  "why can't my integration write to this auto-number field?",
  "is this auto number field available in a before-save trigger?",
  "what does it mean that this field is an Auto Number?",
  "does reformatting an auto number field renumber existing records?",
];
describe('funnel ranking — Arc-2 batch3 field-autonumber-system-assigned-readonly ranks interpret top-5', () => {
  it.each(ARC2_B3_FIELD_AUTONUMBER_SYSTEM_ASSIGNED_READONLY)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_B3_FIELD_MULTISELECT_PICKLIST_STORAGE_SEMANTICS: readonly string[] = [
  "how is a multi-select picklist stored, and how do I query it?",
  "why does my equals filter not match this multi-select picklist?",
  "can a multi-select picklist be the controlling field of a dependent picklist?",
  "do I need INCLUDES to filter a multiselect picklist in SOQL?",
  "what are the reporting limitations of a multi-select picklist field?",
];
describe('funnel ranking — Arc-2 batch3 field-multiselect-picklist-storage-semantics ranks interpret top-5', () => {
  it.each(ARC2_B3_FIELD_MULTISELECT_PICKLIST_STORAGE_SEMANTICS)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_B3_PERMISSION_SET_LICENSE_SCOPED: readonly string[] = [
  "Which permission sets are bound to a specific user license?",
  "Is this permission set restricted to users who hold a particular license?",
  "What does it mean that a permission set has a license set on it?",
  "Can a permission set that is tied to a license be assigned to any user?",
  "Which permission sets can only be assigned to users on a matching license?",
  "Does binding a permission set to a user license limit who can receive its grants?",
];
describe('funnel ranking — Arc-2 batch3 permission-set-license-scoped ranks interpret top-5', () => {
  it.each(ARC2_B3_PERMISSION_SET_LICENSE_SCOPED)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_B3_SESSION_BASED_PERMISSION_SET_DORMANT: readonly string[] = [
  "Which permission sets require session activation before their grants apply?",
  "Is this permission set session-based, so its access stays dormant until activated?",
  "Does this permission set grant its object and field access passively or only after session activation?",
  "What permission sets confer no standing access because they are activation-gated?",
  "Are the CRUD and Apex-class grants on this permission set conditional on session activation?",
];
describe('funnel ranking — Arc-2 batch3 session-based-permission-set-dormant ranks interpret top-5', () => {
  it.each(ARC2_B3_SESSION_BASED_PERMISSION_SET_DORMANT)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});


/**
 * ARC-2 build-all batch — 14 more concepts, NL-reachable via grow-forever cards.
 */
const ARC2_BA_FIELD_RESTRICTED_GLOBAL_VALUE_SET: readonly string[] = [
  "Is this picklist field restricted to a fixed set of values?",
  "Can an admin add new values to this picklist directly on the field?",
  "Does the Status picklist on Case use a locked-down global value set?",
  "Will an API write be rejected if it sends a value not in this picklist?",
  "Which fields share this global value set and can their values drift?",
  "Is this picklist a closed vocabulary or can users enter free-form values?",
];
describe('funnel ranking — Arc-2 build-all concept:field-restricted-global-value-set ranks interpret top-5', () => {
  it.each(ARC2_BA_FIELD_RESTRICTED_GLOBAL_VALUE_SET)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_FIELD_PICKLIST_HAS_RETIRED_VALUES: readonly string[] = [
  "Which picklist fields still have inactive values?",
  "Does the Account Industry picklist have any retired values?",
  "Show me picklists with old values that are no longer selectable",
  "Are there deactivated picklist values left on Opportunity fields?",
  "Find fields that kept legacy picklist entries after cleanup",
  "List picklists carrying retired values from a past migration",
];
describe('funnel ranking — Arc-2 build-all concept:field-picklist-has-retired-values ranks interpret top-5', () => {
  it.each(ARC2_BA_FIELD_PICKLIST_HAS_RETIRED_VALUES)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_APPROVAL_PROCESS_INACTIVE_DEAD: readonly string[] = [
  "Is this approval process still active?",
  "Which approval processes on Account are inactive?",
  "If this approval process is deactivated, does submitting a record for approval do anything?",
  "Show me the dead approval processes in this org",
  "Does this inactive approval process still lock records on approval?",
  "Will its final-approval field update run while the process is off?",
];
describe('funnel ranking — Arc-2 build-all concept:approval-process-inactive-dead ranks interpret top-5', () => {
  it.each(ARC2_BA_APPROVAL_PROCESS_INACTIVE_DEAD)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_ESCALATION_RULE_TIME_DEFERRED: readonly string[] = [
  "Do my escalation rules run during the save or later?",
  "When does a case escalation actually fire?",
  "Are escalation actions synchronous with the record update?",
  "Does this escalation rule reassign the case immediately or on a timer?",
  "Is case escalation part of the save transaction?",
  "What happens after a record ages past its escalation threshold?",
];
describe('funnel ranking — Arc-2 build-all concept:escalation-rule-time-deferred ranks interpret top-5', () => {
  it.each(ARC2_BA_ESCALATION_RULE_TIME_DEFERRED)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_AUTO_RESPONSE_RULE_FIRST_MATCH_STARVATION: readonly string[] = [
  "Show me the auto-response rules for Lead",
  "Why did this case get the wrong auto-response email?",
  "Do any auto-response rule entries never fire?",
  "Is there a catch-all auto-response entry starving later ones?",
  "Which auto-response rule entries are unreachable on Case?",
  "Are my auto-response rule entries in the right order?",
];
describe('funnel ranking — Arc-2 build-all concept:auto-response-rule-first-match-starvation ranks interpret top-5', () => {
  it.each(ARC2_BA_AUTO_RESPONSE_RULE_FIRST_MATCH_STARVATION)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_RECORD_TYPE_BUSINESS_PROCESS_BINDING: readonly string[] = [
  "Which record types are tied to a specific sales process?",
  "Does this record type limit which stages are available on an opportunity?",
  "What business process is bound to the Enterprise record type?",
  "Why can't I pick this status value on a case with this record type?",
  "Show me record types that restrict the status picklist to a business process",
  "Which record types scope the stage picklist to a subset of values?",
];
describe('funnel ranking — Arc-2 build-all concept:record-type-business-process-binding ranks interpret top-5', () => {
  it.each(ARC2_BA_RECORD_TYPE_BUSINESS_PROCESS_BINDING)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_APEX_DYNAMIC_REFLECTIVE_SURFACE: readonly string[] = [
  "Does this Apex class use dynamic SOQL or reflection that static analysis can't see?",
  "Which classes build queries or field references at runtime?",
  "Is the impact analysis for this class complete, or are there reflective blind spots?",
  "Show me Apex that uses dynamic queries, describes, or type reflection",
  "What classes could have hidden dependencies my usage results miss?",
  "Are there dynamic-Apex constructs that make dead-code findings unreliable here?",
];
describe('funnel ranking — Arc-2 build-all concept:apex-dynamic-reflective-surface ranks interpret top-5', () => {
  it.each(ARC2_BA_APEX_DYNAMIC_REFLECTIVE_SURFACE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_NAMED_CREDENTIAL_MERGE_FIELDS_INJECTABLE: readonly string[] = [
  "which named credentials allow merge fields in the HTTP header or body",
  "are any of our named credentials an injection surface for outbound callouts",
  "show me named credentials that lifted the default merge-field guard",
  "list named credentials configured with allowMergeFieldsInHeader or allowMergeFieldsInBody",
  "which outbound credentials let Apex substitute merge fields into the request",
];
describe('funnel ranking — Arc-2 build-all concept:named-credential-merge-fields-injectable ranks interpret top-5', () => {
  it.each(ARC2_BA_NAMED_CREDENTIAL_MERGE_FIELDS_INJECTABLE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_CONNECTED_APP_SAML_SSO_FEDERATION: readonly string[] = [
  "Which connected apps are set up as SAML single sign-on service providers?",
  "Is this connected app a SAML SSO federation target with Salesforce as the identity provider?",
  "Which connected apps will Salesforce mint SAML assertions for?",
  "Does this connected app federate a user's identity out to a third party over SAML?",
  "What connected apps declare a SAML config instead of, or alongside, OAuth?",
  "Which connected apps act as SAML service providers we should review as an identity surface?",
];
describe('funnel ranking — Arc-2 build-all concept:connected-app-saml-sso-federation ranks interpret top-5', () => {
  it.each(ARC2_BA_CONNECTED_APP_SAML_SSO_FEDERATION)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_APEX_FAKE_ASSERTION_TEST: readonly string[] = [
  "Which test classes have fake or tautological assertions?",
  "Show me tests that assert true or assert a value against itself",
  "Find Apex tests that pass no matter what the code does",
  "Are any of my test classes inflating coverage without verifying anything?",
  "Which tests use System.assertEquals with identical operands?",
  "List test classes flagged for fake-assertion smells",
];
describe('funnel ranking — Arc-2 build-all concept:apex-fake-assertion-test ranks interpret top-5', () => {
  it.each(ARC2_BA_APEX_FAKE_ASSERTION_TEST)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_ENTITLEMENT_PROCESS_INACTIVE: readonly string[] = [
  "Which entitlement processes are inactive?",
  "Is this SLA / entitlement process actually live or disabled?",
  "Does this entitlement process still start its milestone timers?",
  "Are any of our SLA processes dead or deactivated?",
  "Should I count this entitlement process when reasoning about milestones on Cases?",
  "Why aren't milestones tracking on my Cases?",
];
describe('funnel ranking — Arc-2 build-all concept:entitlement-process-inactive ranks interpret top-5', () => {
  it.each(ARC2_BA_ENTITLEMENT_PROCESS_INACTIVE)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_OMNISTUDIO_INACTIVE_COMPONENT_VERSION: readonly string[] = [
  "Which OmniScripts are inactive?",
  "Do we have any FlexCards that aren't active?",
  "Is this Integration Procedure live or just a saved draft?",
  "Which OmniStudio components won't run at runtime?",
  "Show me the dormant OmniScript versions in this org",
  "Are any of our OmniStudio components deactivated?",
];
describe('funnel ranking — Arc-2 build-all concept:omnistudio-inactive-component-version ranks interpret top-5', () => {
  it.each(ARC2_BA_OMNISTUDIO_INACTIVE_COMPONENT_VERSION)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_REQUIRED_FIELD_ABSENT_FROM_ALL_LAYOUTS: readonly string[] = [
  "Which required fields aren't on any page layout?",
  "Is this required field missing from every layout?",
  "Do we have required fields with no UI data-entry surface?",
  "Which required Account fields can't be entered through the UI?",
  "Show me required fields absent from all page layouts",
  "Are there any universally required fields not placed on a layout?",
];
describe('funnel ranking — Arc-2 build-all concept:required-field-absent-from-all-layouts ranks interpret top-5', () => {
  it.each(ARC2_BA_REQUIRED_FIELD_ABSENT_FROM_ALL_LAYOUTS)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
const ARC2_BA_DATARAPTOR_ERRORS_IGNORED: readonly string[] = [
  "Which DataRaptors ignore errors instead of failing?",
  "Are any of our DataRaptor loads swallowing record failures silently?",
  "Show me OmniStudio data transforms configured to continue on error",
  "Which DataRaptors could be losing data without reporting it?",
  "Do any DataRaptors have 'Ignore Error' turned on?",
  "Find data transforms that don't surface their write failures",
];
describe('funnel ranking — Arc-2 build-all concept:dataraptor-errors-ignored ranks interpret top-5', () => {
  it.each(ARC2_BA_DATARAPTOR_ERRORS_IGNORED)('ranks sfi.interpret in the top-5 for: %s', (q) => {
    const top5 = semanticCandidates(q, 5).map((c) => c.tool);
    expect(top5, `top-5 was: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});
