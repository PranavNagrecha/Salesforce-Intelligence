/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (second review): `safe_to_delete_field`'s `sharing`
 * category covers SharingRule / RestrictionRule / ScopingRule, but none of
 * those families minted an edge to a field — sharing-rule criteria and rule
 * filters lived only in node properties. With the families retrieved, the row
 * read `none-found` for a field two criteria-based sharing rules test (a delete
 * Salesforce refuses). The extractors now mint `references` edges (see
 * extractors/test/rule-field-reference-edges.test.ts); here: such an edge is a
 * blocking `sharing` referrer, and a vault built before those edges existed
 * never reads the row as `none-found`. Names synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { safeToDeleteFieldHandler } from '../../src/tools/safe-to-delete-field.js';

const OBJ = 'CustomObject:Project__c';
const SHARED = 'CustomField:Project__c.Region__c';
const QUIET = 'CustomField:Project__c.Notes__c';
// A RestrictionRule on Project__c whose filter walks a lookup to Contact.
const CONTACT = 'CustomObject:Contact';
const UNRESOLVED_TAIL = 'CustomField:Contact.Owner_User__c';
const RESOLVED_TAIL = 'CustomField:Contact.Advisor_User__c';
const PLAIN = 'CustomField:Contact.Plain__c';
const RULE = 'RestrictionRule:Lead_Only';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (fromId: string, toId: string, edgeType: Edge['edgeType'], properties: Record<string, unknown> = {}): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties,
});

const confirmed = (type: string, retrieved: number) => ({
  type,
  requested: true,
  retrieved,
  errored: false,
  neverModeled: false,
  retrieveConfirmed: true,
});
const manifest = (version: string): ExtendedVaultManifest => ({
  version,
  refreshedAt: '2026-07-10T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-sharing',
  coverageComputedAt: '2026-07-10T00:01:00Z',
  coverage: [
    confirmed('CustomObject', 1),
    confirmed('CustomField', 2),
    confirmed('SharingRule', 1),
    confirmed('RestrictionRule', 1),
    confirmed('ScopingRule', 0),
  ],
});

let dir: string;
let store: GraphStore;
const ctxFor = (version: string): Context => ({ vaultRoot: dir, manifest: manifest(version), graph: store });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-std-sharing-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    {
      nodes: [
        node({ id: OBJ, type: 'CustomObject', apiName: 'Project__c' }),
        node({ id: SHARED, type: 'CustomField', apiName: 'Region__c', parentId: OBJ, properties: { type: 'Text' } }),
        node({ id: QUIET, type: 'CustomField', apiName: 'Notes__c', parentId: OBJ, properties: { type: 'Text' } }),
        node({ id: 'SharingRule:Project__c.Share_West', type: 'SharingRule', apiName: 'Project__c.Share_West', parentId: OBJ }),
        node({ id: CONTACT, type: 'CustomObject', apiName: 'Contact' }),
        node({ id: UNRESOLVED_TAIL, type: 'CustomField', apiName: 'Owner_User__c', parentId: CONTACT, properties: { type: 'Lookup' } }),
        node({ id: RESOLVED_TAIL, type: 'CustomField', apiName: 'Advisor_User__c', parentId: CONTACT, properties: { type: 'Lookup' } }),
        node({ id: PLAIN, type: 'CustomField', apiName: 'Plain__c', parentId: CONTACT, properties: { type: 'Text' } }),
        node({
          id: RULE,
          type: 'RestrictionRule',
          apiName: 'Lead_Only',
          parentId: OBJ,
          properties: { recordFilter: 'Lookup__r.Owner_User__c = $User.Id OR Advisor__r.Advisor_User__c = $User.Id' },
        }),
      ],
      edges: [
        edge(OBJ, SHARED, 'parentOf'),
        edge(OBJ, QUIET, 'parentOf'),
        edge('SharingRule:Project__c.Share_West', SHARED, 'references', { referenceKind: 'sharingCriteria' }),
        edge(CONTACT, UNRESOLVED_TAIL, 'parentOf'),
        edge(CONTACT, RESOLVED_TAIL, 'parentOf'),
        edge(CONTACT, PLAIN, 'parentOf'),
        // The refresh path pass resolved one of the two paths onto its tail.
        edge(RULE, RESOLVED_TAIL, 'references', {
          referenceKind: 'recordFilterPath',
          recordFilterPath: 'Advisor__r.Advisor_User__c',
          pathRole: 'tail',
        }),
      ],
    },
  ]);
  if (!imported.ok) throw new Error(imported.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

const sharingRow = async (ctx: Context, fieldId: string) => {
  const r = await safeToDeleteFieldHandler(ctx, { fieldId });
  if (!r.ok) throw new Error(r.error.message);
  return { data: r.value.data, row: r.value.data.checkedCategories?.find((c) => c.category === 'sharing') };
};

describe('safe_to_delete_field — sharing criteria referrers', () => {
  it('a sharing rule criterion on the field is a blocking sharing referrer', async () => {
    const { data, row } = await sharingRow(ctxFor('0.1.0'), SHARED);
    expect(row?.status).toBe('found');
    expect(data.verdict).toBe('blocking');
    expect(data.reasoning.some((r) => r.category === 'sharing')).toBe(true);
  });

  it('a vault built before the sharing criteria edges never reads the row as none-found', async () => {
    const prior = process.env['SFI_PLUGIN_VERSION'];
    try {
      delete process.env['SFI_PLUGIN_VERSION'];
      expect((await sharingRow(ctxFor('0.3.3'), QUIET)).row?.status).toBe('none-found');
      process.env['SFI_PLUGIN_VERSION'] = '0.4.0';
      const stale = await sharingRow(ctxFor('0.3.3'), QUIET);
      expect(stale.row?.status).toBe('not-checked');
      // A vault built WITH the edges keeps the checked answer.
      expect((await sharingRow(ctxFor('0.4.0'), QUIET)).row?.status).toBe('none-found');
    } finally {
      if (prior === undefined) delete process.env['SFI_PLUGIN_VERSION'];
      else process.env['SFI_PLUGIN_VERSION'] = prior;
    }
  });
});

describe('safe_to_delete_field — restriction rule filter paths (Lookup__r.Field__c)', () => {
  it('a field an unresolved filter path may end on is never "sharing: none-found"', async () => {
    const { data, row } = await sharingRow(ctxFor('0.1.0'), UNRESOLVED_TAIL);
    expect(row?.status).toBe('not-checked');
    expect(row?.missingFamilies).toContain('RestrictionRule');
    expect(data.verdict).not.toBe('safe');
    expect(data.trust?.limitations?.some((l) => l.includes('Lookup__r.Owner_User__c'))).toBe(true);
  });

  it('a path resolved onto the field is a blocking sharing referrer', async () => {
    const { data, row } = await sharingRow(ctxFor('0.1.0'), RESOLVED_TAIL);
    expect(row?.status).toBe('found');
    expect(data.verdict).toBe('blocking');
  });

  it('a field no path ends on keeps the checked answer', async () => {
    expect((await sharingRow(ctxFor('0.1.0'), PLAIN)).row?.status).toBe('none-found');
  });
});
