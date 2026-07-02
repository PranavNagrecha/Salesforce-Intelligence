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
  { q: 'why can this rep not open the case record', anyOf: ['sfi.why_cant_user_see_record'] },
  { q: 'spell out what the Marketing profile is allowed to do', anyOf: ['sfi.effective_permissions', 'sfi.permission_risk_report'] },
  { q: 'which permission sets are assigned to nobody', anyOf: ['sfi.unassigned_permission_sets'] },
  { q: 'give me the sharing picture for the Account object', anyOf: ['sfi.generate_sharing_summary'] },
  { q: 'what falls over if I delete the Discount field', anyOf: ['sfi.get_impact', 'sfi.safe_to_delete_field', 'sfi.field_lineage'] },
  { q: 'is it safe to switch off the renewal flow', anyOf: ['sfi.what_if_deactivate_flow', 'sfi.get_impact'] },
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
  { q: 'which flows write to the Status field on Case', anyOf: ['sfi.why_field_changed', 'sfi.field_provenance'] },
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
