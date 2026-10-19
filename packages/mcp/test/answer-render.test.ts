/// <reference types="vitest/globals" />

import {
  mdTable,
  renderFieldPopulationMarkdown,
  renderInactiveUsersMarkdown,
  renderLiveCountMarkdown,
  renderOrgOverviewMarkdown,
  renderResolveMarkdown,
  renderShortlistMarkdown,
  renderTrustFooter,
} from '../src/answer-render.js';

describe('mdTable', () => {
  it('renders a GFM table and escapes pipes', () => {
    const t = mdTable(['A', 'B'], [['x', 'a|b']]);
    expect(t).toContain('| A | B |');
    expect(t).toContain('| --- | --- |');
    expect(t).toContain('a\\|b');
  });
  it('returns empty string for no rows', () => {
    expect(mdTable(['A'], [])).toBe('');
  });
});

describe('renderResolveMarkdown', () => {
  it('exact → a single verdict line with parent qualifier', () => {
    const md = renderResolveMarkdown({
      disposition: 'exact',
      clarification: null,
      candidates: [
        { apiName: 'Email__c', parentApiName: 'Account', type: 'CustomField', score: 1, evidence: 'exact' },
      ],
    });
    expect(md).toContain('Resolved to **Email__c on Account** (CustomField)');
  });

  it('ambiguous → the clarifying question + a candidate table', () => {
    const md = renderResolveMarkdown({
      disposition: 'ambiguous',
      clarification: { question: 'Which object?' },
      candidates: [
        { apiName: 'Email__c', parentApiName: 'Account', type: 'CustomField', score: 0.9, evidence: 'exact' },
        { apiName: 'Email__c', parentApiName: 'Contact', type: 'CustomField', score: 0.9, evidence: 'exact' },
      ],
    });
    expect(md).toContain('Which object?');
    expect(md).toContain('| # | Component | Type | Score | Why |');
    expect(md).toContain('Email__c on Account');
    expect(md).toContain('Email__c on Contact');
  });

  it('none → an honest no-match prompt', () => {
    const md = renderResolveMarkdown({ disposition: 'none', clarification: null, candidates: [] });
    expect(md).toMatch(/no confident match/i);
  });
});

describe('renderOrgOverviewMarkdown', () => {
  const base = {
    componentCounts: { CustomField: 900, Flow: 40, ApexClass: 30 },
    topObjects: [{ apiName: 'Account', inboundReferences: 50 }],
    automationSummary: {
      flows: 40,
      apexTriggers: 12,
      workflowRules: 3,
      approvalProcesses: 2,
      activeRatio: 0.8,
      activeCount: 44,
      measuredCount: 55,
      activeStatusUnknownCount: 2,
    },
    integrationSummary: { total: 6 },
  };

  it('renders totals, top objects, automation, and recent activity (available)', () => {
    const md = renderOrgOverviewMarkdown({
      ...base,
      recentActivity: {
        available: true,
        refreshCount: 3,
        netComponentChange: 25,
        trend: 'growing',
        lastRefreshComponentDeltas: { CustomField: 20, Flow: 5 },
      },
    });
    expect(md).toContain('## Org overview — 970 components');
    expect(md).toContain('| Type | Count |');
    expect(md).toContain('Account');
    expect(md).toContain('40 flows');
    // PROSE-FROM-ROWS: the percentage names the rows it was computed over.
    expect(md).toContain('44 of 55 automation items active (80%)');
    expect(md).toContain('2 without a status');
    expect(md).not.toContain('workflow rules (');
    expect(md).toContain('Trend over 3 refreshes: growing');
    expect(md).toContain('+20 CustomField');
  });

  it('handles a vault with no history', () => {
    const md = renderOrgOverviewMarkdown({
      ...base,
      recentActivity: {
        available: false,
        refreshCount: 0,
        netComponentChange: null,
        trend: 'unknown',
        lastRefreshComponentDeltas: {},
      },
    });
    expect(md).toMatch(/No refresh history yet/);
  });
});

describe('renderTrustFooter', () => {
  it('stamps a live answer with its query time', () => {
    const f = renderTrustFooter({ provenance: 'live_org', freshness: { liveQueriedAt: '2026-05-29T22:00:00Z' } });
    expect(f).toContain('Live org');
    expect(f).toContain('queried 2026-05-29T22:00:00Z');
    expect(f).toContain('read-only');
  });
  it('stamps an offline answer with its refresh time', () => {
    const f = renderTrustFooter({ provenance: 'offline_snapshot', freshness: { snapshotRefreshedAt: '2026-05-20T00:00:00Z' } });
    expect(f).toContain('Offline snapshot');
    expect(f).toContain('refreshed 2026-05-20T00:00:00Z');
  });
  it('names both planes for a hybrid answer', () => {
    const f = renderTrustFooter({
      provenance: 'hybrid',
      freshness: { liveQueriedAt: '2026-05-29T22:00:00Z', snapshotRefreshedAt: '2026-05-20T00:00:00Z' },
    });
    expect(f).toContain('Hybrid');
    expect(f).toContain('live queried');
    expect(f).toContain('snapshot refreshed');
  });
});

describe('live answer renderers', () => {
  const liveTrust = { provenance: 'live_org' as const, freshness: { liveQueriedAt: '2026-05-29T22:00:00Z' } };

  it('renders a live count with thousands separators + the query + footer', () => {
    const md = renderLiveCountMarkdown({ count: 1234567, soql: 'SELECT COUNT() FROM Account', trust: liveTrust });
    expect(md).toContain('**1,234,567** records');
    expect(md).toContain('SELECT COUNT() FROM Account');
    expect(md).toContain('Live org');
  });

  it('renders field population as X of Y (Z%)', () => {
    const md = renderFieldPopulationMarkdown({
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      totalCount: 1000,
      populatedCount: 940,
      populationRate: 0.94,
      trust: liveTrust,
    });
    expect(md).toContain('`Contact.Email`');
    expect(md).toContain('**940** of 1,000 records');
    expect(md).toContain('**94%**');
  });

  it('renders inactive users with the true total and a capped table', () => {
    const md = renderInactiveUsersMarkdown({
      days: 30,
      totalInactive: 5,
      returned: 2,
      capped: true,
      users: [
        { name: 'Dormant Dan', username: 'dan@x.com', profileName: 'Admin', lastLoginDate: '2026-01-01T00:00:00Z', daysSinceLogin: 148, neverLoggedIn: false },
        { name: 'Never Nora', username: 'nora@x.com', profileName: null, lastLoginDate: null, daysSinceLogin: null, neverLoggedIn: true },
      ],
      trust: liveTrust,
    });
    expect(md).toContain('**5** active users have not logged in within 30 days');
    expect(md).toContain('| User | Username | Profile | Days since login |');
    expect(md).toContain('Dormant Dan');
    expect(md).toContain('never');
    expect(md).toContain('Showing 2 of 5');
  });
});

describe('renderShortlistMarkdown', () => {
  it('renders the ranked shortlist with answers, args and the live note', () => {
    const md = renderShortlistMarkdown({
      question: 'How many Accounts?',
      toolCandidates: [
        { tool: 'sfi.live_count', score: 0.512, plane: 'live', liveRequired: true, answers: 'Count records live.', missingArgs: ['soql'] },
        { tool: 'sfi.list_components', score: 0.3, plane: 'vault', liveRequired: false, answers: 'List components.', suggestedArgs: { type: 'CustomObject' } },
      ],
      clarification: null,
      gap: null,
    });
    expect(md).toContain('Candidate tools for "How many Accounts?"');
    expect(md).toContain('1. `sfi.live_count` (0.512, live · needs the opt-in live plane) — Count records live. · still needs: soql');
    expect(md).toContain('2. `sfi.list_components` (0.300, vault) — List components. · args {"type":"CustomObject"}');
    expect(md).not.toContain('intent');
  });

  it('renders a stop-and-ask and a gap note after the shortlist', () => {
    const md = renderShortlistMarkdown({
      question: 'who can edit the Status field',
      toolCandidates: [
        { tool: 'sfi.field_access_audit', score: 0.4, plane: 'vault', liveRequired: false, answers: 'Who can see a field.' },
      ],
      clarification: { required: true, question: 'Which component did you mean?', options: ['CustomField:A.Status__c', 'CustomField:B.Status__c'] },
      gap: { category: 'unrouted', note: 'thin evidence' },
      entityEvidence: { warning: 'PREMISE CHECK: nope' },
    });
    expect(md).toContain('**Stop before executing:** Which component did you mean? Options: `CustomField:A.Status__c`, `CustomField:B.Status__c`');
    expect(md).toContain('_Gap (`unrouted`): thin evidence_');
    expect(md).toContain('PREMISE CHECK: nope');
  });

  it('is honest about an empty shortlist and a refusal', () => {
    const empty = renderShortlistMarkdown({
      question: 'meaning of life',
      clarification: null,
      gap: { category: 'unrouted', note: 'nothing matched' },
    });
    expect(empty).toMatch(/don't have a tool/i);
    expect(empty).toContain('nothing matched');
    const refused = renderShortlistMarkdown({
      question: 'delete the field for me',
      toolCandidates: [{ tool: 'sfi.safe_to_delete_field', score: 0.5, plane: 'vault', liveRequired: false, answers: 'x' }],
      clarification: null,
      refusal: { disclosure: 'REFUSED (read-only boundary).', readOnlyAlternative: 'sfi.safe_to_delete_field' },
      gap: { category: 'write-request', note: 'refused' },
    });
    expect(refused).toContain('REFUSED (read-only boundary).');
    expect(refused).toContain('Read-only alternative: `sfi.safe_to_delete_field`');
    expect(refused).toContain('transparency only');
  });
});
