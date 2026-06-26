/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import {
  buildDescribeFieldExtraction,
  existingCustomFieldIds,
  existingCustomFieldNodes,
  fieldNeedsDescribeEnrichment,
  mergeDescribeFieldSnapshots,
} from '../src/standard-object-describe-fields.js';

const stubIndustryNode = (): Node => ({
  id: 'CustomField:Account.Industry',
  type: 'CustomField',
  apiName: 'Industry',
  label: 'Industry',
  parentId: 'CustomObject:Account',
  sourcePath: 'source/objects/Account/fields/Industry.field-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {
    label: 'Industry',
    dataType: 'Picklist',
    picklistValues: [],
  },
});

describe('buildDescribeFieldExtraction — FLD-05', () => {
  it('synthesizes CustomField nodes from describe rows', () => {
    const existingById = new Map<string, Node>();
    const result = buildDescribeFieldExtraction(
      'Account',
      {
        fields: [
          { name: 'Industry', label: 'Industry', type: 'picklist', custom: false },
          { name: 'Revenue__c', label: 'Revenue', type: 'currency', custom: true },
        ],
      },
      existingById,
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.id).toBe('CustomField:Account.Industry');
    expect(result.nodes[0]?.properties['provenance']).toBe('org-describe-snapshot');
    expect(result.nodes[0]?.properties['dataType']).toBe('Picklist');
    expect(result.edges).toHaveLength(2);
  });

  it('enriches stub picklist metadata with describe picklist values', () => {
    const existingById = new Map<string, Node>([
      ['CustomField:Account.Industry', stubIndustryNode()],
    ]);
    const result = buildDescribeFieldExtraction(
      'Account',
      {
        fields: [
          {
            name: 'Industry',
            type: 'picklist',
            picklistValues: [
              { value: 'Technology', active: true },
              { value: 'Retired', active: false },
            ],
          },
          { name: 'Phone', type: 'phone' },
        ],
      },
      existingById,
    );
    expect(result.nodes).toHaveLength(2);
    // H10: the describe path now RETAINS the inactive value (was dropped to
    // ['Technology']) and emits the object shape — the active value is
    // isActive:true, the deactivated one isActive:false (describe `active`
    // maps to `isActive = active !== false`). Both provenances (DX inline +
    // describe snapshot) converge on {value,isActive,label?}.
    expect(result.nodes[0]?.properties['picklistValues']).toEqual([
      { value: 'Technology', isActive: true },
      { value: 'Retired', isActive: false },
    ]);
    expect(result.nodes[0]?.properties['describeEnriched']).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.toId).toBe('CustomField:Account.Phone');
  });

  it('H10: carries describe label onto the picklist value object when present', () => {
    const existingById = new Map<string, Node>([
      ['CustomField:Account.Industry', stubIndustryNode()],
    ]);
    const result = buildDescribeFieldExtraction(
      'Account',
      {
        fields: [
          {
            name: 'Industry',
            type: 'picklist',
            picklistValues: [
              { value: 'TECH', label: 'Technology', active: true },
              { value: 'OLD', label: 'Old Value', active: false },
            ],
          },
        ],
      },
      existingById,
    );
    expect(result.nodes[0]?.properties['picklistValues']).toEqual([
      { value: 'TECH', isActive: true, label: 'Technology' },
      { value: 'OLD', isActive: false, label: 'Old Value' },
    ]);
  });

  it('skips fields already retrieved with inline picklist values', () => {
    const complete: Node = {
      ...stubIndustryNode(),
      properties: {
        ...stubIndustryNode().properties,
        picklistValues: ['Banking'],
      },
    };
    const existingById = new Map<string, Node>([['CustomField:Account.Industry', complete]]);
    const result = buildDescribeFieldExtraction(
      'Account',
      {
        fields: [
          {
            name: 'Industry',
            type: 'picklist',
            picklistValues: [{ value: 'Technology', active: true }],
          },
        ],
      },
      existingById,
    );
    expect(result.nodes).toHaveLength(0);
  });
});

describe('fieldNeedsDescribeEnrichment', () => {
  it('flags stub picklist field-meta without values', () => {
    expect(fieldNeedsDescribeEnrichment(stubIndustryNode())).toBe(true);
  });

  it('skips complete inline picklist metadata', () => {
    expect(
      fieldNeedsDescribeEnrichment({
        ...stubIndustryNode(),
        properties: { ...stubIndustryNode().properties, picklistValues: ['A'] },
      }),
    ).toBe(false);
  });
});

describe('existingCustomFieldIds', () => {
  it('collects ids from all extraction results', () => {
    const ids = existingCustomFieldIds([
      { nodes: [{ id: 'CustomField:Account.X', type: 'CustomField' } as never], edges: [] },
    ]);
    expect(ids.has('CustomField:Account.X')).toBe(true);
  });
});

describe('existingCustomFieldNodes', () => {
  it('maps ids to nodes', () => {
    const node = stubIndustryNode();
    const byId = existingCustomFieldNodes([
      { nodes: [node], edges: [] },
    ]);
    expect(byId.get('CustomField:Account.Industry')).toBe(node);
  });
});

describe('mergeDescribeFieldSnapshots', () => {
  it('concatenates overlay results', () => {
    const merged = mergeDescribeFieldSnapshots([
      { nodes: [{ id: 'CustomField:A.X' } as never], edges: [] },
      { nodes: [{ id: 'CustomField:B.Y' } as never], edges: [] },
    ]);
    expect(merged.nodes).toHaveLength(2);
  });
});
