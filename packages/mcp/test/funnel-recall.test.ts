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
