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
