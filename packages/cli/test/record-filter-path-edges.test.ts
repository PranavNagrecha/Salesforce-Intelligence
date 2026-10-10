/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (second review, metarefs-B1 residue): a restriction /
 * scoping rule filter `Lookup__r.Field__c = $User.Id` tests a field on the
 * RELATED object, but only the first hop (`Lookup__c`) got an edge. A field
 * used only in such a filter read "sharing: none-found" in
 * safe_to_delete_field. `resolveRecordFilterPathEdges` now follows each hop
 * through the lookup's target and mints an edge onto the tail field; a path it
 * cannot resolve is listed on the rule node. Names synthetic.
 */

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { RECORD_FILTER_PATH_SOURCE, resolveRecordFilterPathEdges } from '../src/refresh-pipeline.js';

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
const lookup = (fromId: string, target: string): Edge => ({
  fromId,
  toId: `CustomObject:${target}`,
  edgeType: 'lookupTo',
  confidence: 'declared',
  source: 'custom-field-extractor',
  properties: {},
});

const fields: ExtractionResult = {
  nodes: [
    node({ id: 'CustomField:Project__c.Lookup__c', type: 'CustomField', apiName: 'Lookup__c', parentId: 'CustomObject:Project__c' }),
    node({ id: 'CustomField:Contact.Field__c', type: 'CustomField', apiName: 'Field__c', parentId: 'CustomObject:Contact' }),
    node({ id: 'CustomField:Contact.Next__c', type: 'CustomField', apiName: 'Next__c', parentId: 'CustomObject:Contact' }),
    node({ id: 'CustomField:Region__c.Code__c', type: 'CustomField', apiName: 'Code__c', parentId: 'CustomObject:Region__c' }),
  ],
  edges: [
    lookup('CustomField:Project__c.Lookup__c', 'Contact'),
    lookup('CustomField:Contact.Next__c', 'Region__c'),
  ],
};
const rule = (paths: readonly string[]): ExtractionResult => ({
  nodes: [
    node({
      id: 'RestrictionRule:Lead_Only',
      type: 'RestrictionRule',
      apiName: 'Lead_Only',
      parentId: 'CustomObject:Project__c',
      properties: { recordFilterPaths: paths },
    }),
  ],
  edges: [],
});

const minted = (results: readonly ExtractionResult[]) =>
  results
    .flatMap((r) => r.edges)
    .filter((e) => e.source === RECORD_FILTER_PATH_SOURCE)
    .map((e) => [e.toId, e.properties['pathRole']])
    .sort();

describe('resolveRecordFilterPathEdges', () => {
  it('Lookup__r.Field__c mints an edge onto the related object field (and the hop)', () => {
    const out = resolveRecordFilterPathEdges([fields, rule(['Lookup__r.Field__c'])]);
    expect(minted(out)).toEqual([
      ['CustomField:Contact.Field__c', 'tail'],
      ['CustomField:Project__c.Lookup__c', 'hop'],
    ]);
    expect(out[1]?.nodes[0]?.properties['unresolvedRecordFilterPaths']).toBeUndefined();
  });

  it('follows a multi-hop path and matches case-insensitively', () => {
    const out = resolveRecordFilterPathEdges([fields, rule(['lookup__r.next__r.CODE__c'])]);
    expect(minted(out)).toEqual([
      ['CustomField:Contact.Next__c', 'hop'],
      ['CustomField:Project__c.Lookup__c', 'hop'],
      ['CustomField:Region__c.Code__c', 'tail'],
    ]);
  });

  it('a hop with no known target is listed as unresolved, never dropped silently', () => {
    const out = resolveRecordFilterPathEdges([fields, rule(['Missing__r.Field__c'])]);
    expect(minted(out)).toEqual([]);
    expect(out[1]?.nodes[0]?.properties['unresolvedRecordFilterPaths']).toEqual(['Missing__r.Field__c']);
  });

  it('is an identity no-op when no rule carries a path', () => {
    const input = [fields];
    expect(resolveRecordFilterPathEdges(input)).toBe(input);
  });
});
