/// <reference types="vitest/globals" />

import {
  mdTable,
  renderFieldPopulationMarkdown,
  renderInactiveUsersMarkdown,
  renderLiveCountMarkdown,
  renderOrgOverviewMarkdown,
  renderResolveMarkdown,
  renderRouteMarkdown,
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
    automationSummary: { flows: 40, apexTriggers: 12, workflowRules: 3, activeRatio: 0.8 },
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

describe('renderRouteMarkdown', () => {
  it('renders a routed plan with the tool sequence', () => {
    const md = renderRouteMarkdown({
      question: 'How many Accounts?',
      plane: 'live',
      intent: 'record-count',
      tools: ['sfi.live_count'],
      liveRequired: true,
      needsResolve: false,
      reason: 'A record COUNT is live data.',
      gap: null,
    });
    expect(md).toContain('**live** plane');
    expect(md).toContain('`record-count`');
    expect(md).toContain('`sfi.live_count`');
    expect(md).toContain('live plane');
  });

  it('does not list sfi.resolve twice when the route both needsResolve and leads with it', () => {
    const md = renderRouteMarkdown({
      question: 'is it safe to delete the Discount__c field?',
      plane: 'vault',
      intent: 'safe-to-delete',
      tools: ['sfi.resolve', 'sfi.safe_to_delete_field'],
      liveRequired: false,
      needsResolve: true,
      reason: 'Coverage-aware dependency check.',
      gap: null,
    });
    expect(md).toContain('`sfi.resolve` the named component first');
    expect(md).toContain('`sfi.safe_to_delete_field`');
    // The "resolve first" prefix already covers it — the tool list must not repeat it.
    expect(md.match(/sfi\.resolve/g)).toHaveLength(1);
    expect(md).not.toContain('first → `sfi.resolve`');
  });

  it('is honest about an unknown route', () => {
    const md = renderRouteMarkdown({
      question: 'meaning of life',
      plane: 'unknown',
      intent: 'unrouted',
      tools: ['sfi.resolve'],
      liveRequired: false,
      needsResolve: true,
      reason: 'No rule matched.',
      gap: { category: 'unrouted', note: 'logged' },
    });
    expect(md).toMatch(/don't have a tool/i);
    expect(md).toContain('unrouted');
  });
});
