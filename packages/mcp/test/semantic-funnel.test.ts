/// <reference types="vitest/globals" />

import { resetFunnelIndex, semanticCandidates, tokenize } from '../src/semantic-funnel.js';

beforeEach(() => resetFunnelIndex());

const names = (q: string, k?: number): string[] =>
  semanticCandidates(q, k).map((c) => c.tool);

describe('tokenize', () => {
  it('lowercases, splits snake_case, drops stopwords and 1-char tokens', () => {
    const t = tokenize("Where is the Payment_Status__c field?");
    expect(t).toContain('payment'); // snake_case split
    expect(t).toContain('status');
    expect(t).toContain('field');
    expect(t).not.toContain('the'); // stopword
    expect(t).not.toContain('c'); // 1-char dropped (from __c)
  });

  it('returns nothing for a stopword-only / empty question', () => {
    expect(tokenize('what is the')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('semanticCandidates — recall@8 (the gap CAE-01 closes)', () => {
  // Each row: a natural-language question regex routing struggled with, and a
  // set of acceptable tools — at least one MUST appear in the top-8 candidates.
  const RECALL: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
    {
      // the exact live-demo miss that today returns `unrouted`
      q: 'where does Pranav have access to',
      anyOf: [
        'sfi.why_cant_user_see_record',
        'sfi.field_access_audit',
        'sfi.crud_fls_audit',
        'sfi.generate_sharing_summary',
        'sfi.unassigned_permission_sets',
      ],
    },
    {
      q: 'who can edit the Salary field',
      anyOf: ['sfi.field_access_audit', 'sfi.crud_fls_audit', 'sfi.why_cant_user_see_record'],
    },
    {
      q: 'what breaks if I delete this field',
      anyOf: ['sfi.get_impact', 'sfi.safe_to_delete_field', 'sfi.field_lineage', 'sfi.downstream_effects'],
    },
    {
      q: 'what automation runs when a Case is created',
      anyOf: ['sfi.order_of_execution', 'sfi.what_happens_on_save'],
    },
    {
      q: 'generate an admin handbook for this org',
      anyOf: ['sfi.generate_admin_handbook', 'sfi.org_overview'],
    },
    {
      q: 'where is PII stored in this org',
      anyOf: ['sfi.pii_inventory'],
    },
    {
      q: 'what external systems does this org talk to',
      anyOf: ['sfi.integration_map', 'sfi.endpoint_catalog'],
    },
    {
      q: 'How many custom fields are on Contact?',
      anyOf: ['sfi.list_components'],
    },
  ];

  it.each(RECALL)('surfaces a relevant tool for: $q', ({ q, anyOf }) => {
    const top = names(q, 8);
    expect(top.some((t) => anyOf.includes(t))).toBe(true);
  });
});

describe('semanticCandidates — shape & honesty', () => {
  it('returns at most k candidates, descending by score, all > 0', () => {
    const out = semanticCandidates('who can edit the Salary field', 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
    }
    expect(out.every((c) => c.score > 0)).toBe(true);
    expect(out.every((c) => c.tool.startsWith('sfi.'))).toBe(true);
  });

  it('returns nothing for a stopword-only or gibberish question (no false routes)', () => {
    expect(semanticCandidates('what is the')).toEqual([]);
    expect(semanticCandidates('zxqw plkj vbnm')).toEqual([]);
    expect(semanticCandidates('')).toEqual([]);
  });

  it('is deterministic — same question, identical ranking', () => {
    const a = semanticCandidates('where does Pranav have access to', 8);
    resetFunnelIndex();
    const b = semanticCandidates('where does Pranav have access to', 8);
    expect(a).toEqual(b);
  });
});

// R3 candidate-generation bands (DIAGNOSIS-R3 §2): the two weak families —
// permissions (custom-permission vocabulary, PSG expansion, access
// diagnostics) and flows (explain/diagnostics/what-if) — must surface their
// gold tool in the funnel's own top ranks for representative phrasings. All
// names synthetic. Top-3 is the bar the funnel-advisory route actually ships.
describe('R3 corpus bands — permissions + flows families reach their tools', () => {
  const expectTop = (q: string, tool: string, k: number) => {
    const top = names(q, 8).slice(0, k);
    expect(top, `expected ${tool} in top-${k} for "${q}" — got ${top.join(', ')}`).toContain(tool);
  };

  it('custom-permission describe/bypass phrasings reach search_components', () => {
    expectTop('What does the Bypass_Widget_Validation custom permission bypass?', 'sfi.search_components', 3);
    expectTop('whos allowed to bypass the widget validation and whats that guarding', 'sfi.search_components', 3);
  });

  it('custom-permission enumeration reaches list_components', () => {
    expectTop('Which custom permissions exist and what do they gate?', 'sfi.list_components', 3);
    expectTop('What custom permissions are defined?', 'sfi.list_components', 3);
  });

  it('reverse custom-permission grants reach find_component_usages', () => {
    expectTop('which perm sets or PSGs turn on the Bypass_Widget custom permission and who ends up with it?', 'sfi.find_component_usages', 3);
    expectTop('what perm set gives access to the risk score component', 'sfi.find_component_usages', 3);
  });

  it('PSG expansion reaches effective_permissions (the answerable direction)', () => {
    expectTop('what does a user get through the Advisor_Perm_Group permission set group?', 'sfi.effective_permissions', 3);
    expectTop('If someone is assigned the Advisor permission set group, do they automatically get WidgetEdit, yes or no?', 'sfi.effective_permissions', 3);
  });

  it('access-diagnostics symptoms reach the diagnostic tools', () => {
    expectTop('user cant edit the widget code field, they say the field is greyed out', 'sfi.field_access_audit', 3);
    expectTop('user says the Convert button is missing on a Lead, why', 'sfi.user_ability', 3);
  });

  it('flow-explain and flow-diagnostics phrasings reach explain_flow', () => {
    expectTop('Give me a breakdown of the Zorp_Accommodation_Flow.', 'sfi.explain_flow', 3);
    expectTop('before i touch the Zorp_Stage_Date_Update flow, what does it even do', 'sfi.explain_flow', 3);
  });

  it('save-cascade phrasings reach what_happens_on_save', () => {
    expectTop('whats on save for the Payment__c object', 'sfi.what_happens_on_save', 3);
    expectTop('How many automations fire when an Application gets saved?', 'sfi.what_happens_on_save', 3);
  });

  it('deactivation what-ifs reach what_if_deactivate_flow', () => {
    expectTop('deactivating Zorp_Accommodation_Flow — consequences?', 'sfi.what_if_deactivate_flow', 3);
    expectTop('deactivate Zorp_Calc_Flow and tell me what stops recalculating', 'sfi.what_if_deactivate_flow', 3);
  });

  it('q738-class flow-metadata searches reach search_flow_metadata/search_components', () => {
    const top = names('Does any flow reference the Bypass_Widget_Validation custom permission to skip a validation rule?', 8).slice(0, 3);
    expect(top.some((t) => t === 'sfi.search_flow_metadata' || t === 'sfi.search_components')).toBe(true);
    expectTop('which custom permissions are checked inside flows', 'sfi.search_flow_metadata', 3);
  });

  it('existence-verification asks reach resolve (trap-122-a family)', () => {
    expectTop('does the Zorp_Code__c field exist on Contact or only on Lead?', 'sfi.resolve', 8);
    expectTop('is Zorp_Widget_Flow even the right name? prove it actually exists', 'sfi.resolve', 8);
  });
});
