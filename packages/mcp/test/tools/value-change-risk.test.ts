/// <reference types="vitest/globals" />

import type {
  FieldClassification,
  UpsertSignal,
} from '../../src/tools/value-change-classification.js';
import {
  buildBuckets,
  buildDisclosures,
  type EdgeSummary,
} from '../../src/tools/value-change-risk.js';

const NO_EDGES: EdgeSummary = { automation: [], code: [], integration: [], display: [] };

const cls = (
  object: string,
  field: string,
  opts: { signals?: UpsertSignal[]; derived?: boolean } = {},
): FieldClassification => ({
  fieldId: `CustomField:${object}.${field}`,
  object,
  field,
  mutability: opts.derived
    ? { mutability: 'derived', reason: 'Formula field — computed.', sourceFormula: 'Related_Widget__r.Member_ID__c' }
    : { mutability: 'writable', reason: 'Directly editable field.' },
  upsertKey: { isUpsertKey: (opts.signals?.length ?? 0) > 0, signals: opts.signals ?? [] },
  role: { role: 'x', severity: 'low', confidence: 'confirmed', signals: [] },
});

const has = (buckets: ReturnType<typeof buildBuckets>, b: string) => buckets.some((x) => x.bucket === b);
const get = (buckets: ReturnType<typeof buildBuckets>, b: string) => buckets.find((x) => x.bucket === b)!;

describe('buildBuckets', () => {
  it('confirms an externalId SIS key as a high integration-key bucket', () => {
    const buckets = buildBuckets(cls('Account', 'External_Ref_Id__c', { signals: ['externalId'] }), NO_EDGES);
    expect(has(buckets, 'integration-key')).toBe(true);
    expect(get(buckets, 'integration-key').severity).toBe('high');
    expect(get(buckets, 'integration-key').confidence).toBe('confirmed');
  });

  it('rates User.Username as a critical identity bucket', () => {
    const buckets = buildBuckets(cls('User', 'Username', { signals: ['idLookup'] }), NO_EDGES);
    expect(has(buckets, 'identity')).toBe(true);
    expect(get(buckets, 'identity').severity).toBe('critical');
  });

  it('separates a unique-only field into uniqueness, NOT integration-key (P1 refinement)', () => {
    const buckets = buildBuckets(cls('CalendarMonthList__c', 'NumberValue__c', { signals: ['unique'] }), NO_EDGES);
    expect(has(buckets, 'uniqueness')).toBe(true);
    expect(has(buckets, 'integration-key')).toBe(false);
    expect(get(buckets, 'uniqueness').severity).toBe('medium');
  });

  it('short-circuits a derived field to a single info note (no impact buckets)', () => {
    const buckets = buildBuckets(cls('Education__c', 'Member_ID__c', { derived: true }), NO_EDGES);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.severity).toBe('info');
    expect(buckets[0]!.summary).toMatch(/Not directly changeable/);
  });

  it('a plain field with no signals yields only the info-level save-pipeline note', () => {
    const buckets = buildBuckets(cls('Account', 'Notes__c'), NO_EDGES);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.bucket).toBe('save-pipeline');
    expect(buckets[0]!.severity).toBe('info');
  });

  it('surfaces an automation bucket from referencing automation/code edges', () => {
    const edges: EdgeSummary = {
      automation: ['ValidationRule:Account.Foo', 'Flow:Bar'],
      code: ['ApexClass:Baz'],
      integration: [],
      display: ['Layout:Account-Account Layout'],
    };
    const buckets = buildBuckets(cls('Account', 'Status__c'), edges);
    expect(has(buckets, 'automation')).toBe(true);
    expect(get(buckets, 'automation').severity).toBe('medium');
    expect(get(buckets, 'automation').evidence).toContain('ValidationRule:Account.Foo');
    expect(has(buckets, 'display')).toBe(true);
  });
});

describe('buildDisclosures — honesty surface', () => {
  it('discloses the external-system blind spot for an integration key', () => {
    const buckets = buildBuckets(cls('Account', 'Marketo_Id__c', { signals: ['externalId'] }), NO_EDGES);
    const d = buildDisclosures(buckets);
    expect(d.some((x) => /external system|middleware|ETL/i.test(x))).toBe(true);
  });
  it('always discloses reports/list-view/manual key usage', () => {
    const d = buildDisclosures(buildBuckets(cls('Account', 'Notes__c'), NO_EDGES));
    expect(d.some((x) => /Reports, list-view/i.test(x))).toBe(true);
  });
});
