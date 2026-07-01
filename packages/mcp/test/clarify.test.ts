/// <reference types="vitest/globals" />

import type { ResolveResult } from '@sf-intelligence/graph';

import { buildClarify } from '../src/clarify.js';

const VAULT = { refreshedAt: '2026-05-20T00:00:00.000Z' };

/** Parent object from a canonical id: `CustomField:Account.Email__c` -> `Account`. */
const parentFromId = (id: string): string | null => {
  const scoped = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const dot = scoped.indexOf('.');
  return dot === -1 ? null : scoped.slice(0, dot);
};

const candidate = (
  id: string,
  apiName: string,
  type: 'CustomField' | 'CustomObject' | 'Flow' = 'CustomField',
) => ({
  id,
  type,
  apiName,
  label: apiName.replace(/__c$/, ''),
  parentApiName: parentFromId(id),
  score: 1,
  base: 1,
  matchKind: 'exact' as const,
  evidence: `exact match on "${apiName}"`,
});

describe('buildClarify', () => {
  it('on ambiguous: produces a ready-to-ask question + one option per candidate', () => {
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['email'],
      candidates: [
        candidate('CustomField:Account.Email__c', 'Email__c'),
        candidate('CustomField:Contact.Email__c', 'Email__c'),
      ],
    };
    const out = buildClarify('email', result, VAULT);
    expect(out.clarification).not.toBeNull();
    if (out.clarification === null) return;
    expect(out.clarification.question.toLowerCase()).toContain('email');
    expect(out.clarification.options).toHaveLength(2);
    expect(out.clarification.options[0]?.value).toBe('CustomField:Account.Email__c');
    // Option label disambiguates by parent object so the user can choose.
    expect(out.clarification.options[0]?.label).toContain('Account');
    expect(out.clarification.options[1]?.label).toContain('Contact');
  });

  it('on exact: no clarification needed (single confident match)', () => {
    const result: ResolveResult = {
      disposition: 'exact',
      queryTokens: ['payment'],
      candidates: [candidate('CustomObject:Payment__c', 'Payment__c')],
    };
    const out = buildClarify('payment', result, VAULT);
    expect(out.clarification).toBeNull();
  });

  it('on none: offers to refresh from the org (with /sfi-refresh) or stop', () => {
    const result: ResolveResult = {
      disposition: 'none',
      queryTokens: ['zzzqqq'],
      candidates: [],
    };
    const out = buildClarify('zzzqqq', result, VAULT);
    expect(out.clarification).toBeNull();
    const actions = out.nextActions.map((a) => a.action);
    expect(actions).toContain('refresh');
    expect(actions).toContain('stop');
    const refresh = out.nextActions.find((a) => a.action === 'refresh');
    expect(refresh?.command).toBe('/sfi-refresh');
    // The refresh reason names the freshness so the user can judge staleness.
    expect(refresh?.reason).toContain('2026-05-20');
  });

  it('on none with scopedCoverageComplete: leads with stop, frames absence as a false premise not a coverage gap (batch 8)', () => {
    const result: ResolveResult = {
      disposition: 'none',
      queryTokens: ['applicationsubmissionservice'],
      candidates: [],
    };
    const out = buildClarify('ApplicationSubmissionService', result, {
      ...VAULT,
      scopedCoverageComplete: true,
    });
    expect(out.clarification).toBeNull();
    // `stop` must come FIRST (determinate negative), refresh demoted to second.
    expect(out.nextActions[0]?.action).toBe('stop');
    expect(out.nextActions[1]?.action).toBe('refresh');
    // The stop reason must state the component does not exist / false premise,
    // and must NOT frame it as a coverage gap.
    const stop = out.nextActions.find((a) => a.action === 'stop');
    expect(stop?.reason).toContain('does not exist');
    expect(stop?.reason).toContain('not a coverage gap');
    // The refresh is demoted: it must say a refresh cannot surface a
    // nonexistent component, not "the vault may be stale".
    const refresh = out.nextActions.find((a) => a.action === 'refresh');
    expect(refresh?.reason).toContain('cannot surface');
    expect(refresh?.reason).not.toContain('the vault may be stale');
  });

  it('on none WITHOUT scopedCoverageComplete: keeps the inconclusive refresh-first framing (regression guard)', () => {
    const result: ResolveResult = {
      disposition: 'none',
      queryTokens: ['zzzqqq'],
      candidates: [],
    };
    const out = buildClarify('zzzqqq', result, VAULT);
    expect(out.nextActions[0]?.action).toBe('refresh');
    const refresh = out.nextActions.find((a) => a.action === 'refresh');
    expect(refresh?.reason).toContain('the vault may be stale');
  });

  it('on ambiguous with more candidates than the option cap: caps options and stays honest about the total', () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      candidate(`CustomField:Obj${i}.Email__c`, 'Email__c'),
    );
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['email'],
      candidates,
    };
    const out = buildClarify('email', result, VAULT);
    expect(out.clarification).not.toBeNull();
    if (out.clarification === null) return;
    // Options are capped (MAX_OPTIONS = 8) so the question stays answerable...
    expect(out.clarification.options).toHaveLength(8);
    // ...but the question must not imply only 8 matched — it names the true
    // total (12) and discloses it is showing the top 8.
    expect(out.clarification.question).toContain('12');
    expect(out.clarification.question).toContain('top 8');
  });

  it('on ambiguous cross-object collision: disambiguateBy=object + names the object dimension', () => {
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['email'],
      candidates: [
        candidate('CustomField:Account.Email__c', 'Email__c'),
        candidate('CustomField:Contact.Email__c', 'Email__c'),
      ],
    };
    const out = buildClarify('email', result, VAULT);
    expect(out.clarification?.disambiguateBy).toBe('object');
    expect(out.clarification?.question.toLowerCase()).toContain('object');
    const narrow = out.nextActions.find((a) => a.action === 'narrow');
    expect(narrow?.label).toBe('Narrow by object');
  });

  it('on ambiguous cross-type collision: disambiguateBy=type', () => {
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['status'],
      candidates: [
        candidate('CustomField:Account.Status__c', 'Status__c', 'CustomField'),
        candidate('Flow:Status', 'Status', 'Flow'),
      ],
    };
    const out = buildClarify('status', result, VAULT);
    expect(out.clarification?.disambiguateBy).toBe('type');
    expect(out.clarification?.question.toLowerCase()).toContain('type');
  });

  it('on ambiguous distinct names: disambiguateBy=name', () => {
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['log'],
      candidates: [
        candidate('CustomObject:Error_Log__c', 'Error_Log__c', 'CustomObject'),
        candidate('CustomObject:Audit_Log__c', 'Audit_Log__c', 'CustomObject'),
      ],
    };
    const out = buildClarify('log', result, VAULT);
    expect(out.clarification?.disambiguateBy).toBe('name');
  });

  it('on ambiguous: also offers to narrow as a next action', () => {
    const result: ResolveResult = {
      disposition: 'ambiguous',
      queryTokens: ['email'],
      candidates: [
        candidate('CustomField:Account.Email__c', 'Email__c'),
        candidate('CustomField:Contact.Email__c', 'Email__c'),
      ],
    };
    const out = buildClarify('email', result, VAULT);
    expect(out.nextActions.some((a) => a.action === 'narrow')).toBe(true);
  });
});
