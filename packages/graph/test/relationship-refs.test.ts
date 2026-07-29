/// <reference types="vitest/globals" />
/**
 * Import-time relationship resolution — the pass that closes two blind spots
 * that both produced the same dangerous shape: a real, live field reporting
 * ZERO referrers, and therefore reading as safe to delete.
 *
 *   1. A formula that reads a field only through a relationship traversal
 *      (`Enrolment__r.Status__c`). The tokenizer saw the path; nothing
 *      downstream could resolve it, so no edge was minted.
 *   2. A dynamic related list on a Lightning page, whose columns are BARE field
 *      names on the RELATED object — invisible to the page's own field sweep.
 *
 * The invariant these tests exist to hold is `resolve or drop, never guess`: an
 * unresolvable traversal must mint NOTHING, because a dangling id would present
 * as evidence of a referrer that does not exist.
 *
 * All fixture names are invented.
 */
import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';

import {
  buildRelationshipMaps,
  mintRelationshipTraversalEdges,
} from '../src/relationship-refs.js';

const field = (
  object: string,
  apiName: string,
  properties: Record<string, unknown> = {},
): Node => ({
  id: `CustomField:${object}.${apiName}` as ComponentId,
  type: 'CustomField',
  apiName,
  label: null,
  parentId: `CustomObject:${object}` as ComponentId,
  sourcePath: `objects/${object}/fields/${apiName}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const flexiPage = (apiName: string, properties: Record<string, unknown>): Node => ({
  id: `FlexiPage:${apiName}` as ComponentId,
  type: 'FlexiPage',
  apiName,
  label: null,
  parentId: null,
  sourcePath: `flexipages/${apiName}.flexipage-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

/**
 * A two-object model: `Enrolment__c` holds a lookup to `Programme__c`, named
 * `Programme__c` on the field and `Enrolments` as the child relationship.
 */
const LOOKUP = field('Enrolment__c', 'Programme__c', {
  referenceTo: 'Programme__c',
  relationshipName: 'Enrolments',
});
const TARGET_FIELD = field('Programme__c', 'Status__c', {});
const CHILD_FIELD = field('Enrolment__c', 'Outcome__c', {});

describe('buildRelationshipMaps', () => {
  it('maps a lookup both parentward (Field__r) and childward (relationshipName)', () => {
    const maps = buildRelationshipMaps([LOOKUP, TARGET_FIELD, CHILD_FIELD]);
    // Parentward: from Enrolment__c, `Programme__r` reaches Programme__c.
    expect(maps.parentward.get('enrolment__c|programme__r')).toBe('Programme__c');
    // Childward: `Enrolments__r` from the parent reaches the object holding the
    // lookup — the direction a related list traverses.
    expect(maps.childward.get('enrolments__r')).toBe('Enrolment__c');
    expect(maps.childward.get('enrolments')).toBe('Enrolment__c');
  });

  it('drops an ambiguous child relationship name rather than picking one', () => {
    const rival = field('Withdrawal__c', 'Programme__c', {
      referenceTo: 'Programme__c',
      relationshipName: 'Enrolments',
    });
    const maps = buildRelationshipMaps([LOOKUP, rival]);
    expect(maps.childward.has('enrolments__r')).toBe(false);
    // The parentward direction is keyed by owning object, so it stays unambiguous.
    expect(maps.parentward.get('withdrawal__c|programme__r')).toBe('Programme__c');
  });
});

describe('mintRelationshipTraversalEdges — formula traversals', () => {
  it('resolves a single-hop traversal onto the real field on the related object', () => {
    const formulaField = field('Enrolment__c', 'Programme_Status__c', {
      isFormula: true,
      formulaRelationshipRefs: ['Programme__r.Status__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [LOOKUP, TARGET_FIELD, formulaField],
      edges,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.fromId).toBe('CustomField:Enrolment__c.Programme_Status__c');
    expect(edges[0]?.toId).toBe('CustomField:Programme__c.Status__c');
    expect(edges[0]?.edgeType).toBe('references');
    // Parsed, not declared: tokenized then inferred through the relationship map.
    expect(edges[0]?.confidence).toBe('parsed');
    expect(edges[0]?.properties['traversalPath']).toBe('Programme__r.Status__c');
  });

  it('resolves a multi-hop traversal through two relationships', () => {
    const faculty = field('Programme__c', 'Faculty__c', {
      referenceTo: 'Faculty__c',
      relationshipName: 'Programmes',
    });
    const facultyCode = field('Faculty__c', 'Code__c', {});
    const formulaField = field('Enrolment__c', 'Faculty_Code__c', {
      isFormula: true,
      formulaRelationshipRefs: ['Programme__r.Faculty__r.Code__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [LOOKUP, faculty, facultyCode, formulaField],
      edges,
    );
    expect(edges.map((e) => e.toId)).toEqual(['CustomField:Faculty__c.Code__c']);
  });

  it('mints NOTHING when a hop cannot be resolved — never a dangling id', () => {
    const formulaField = field('Enrolment__c', 'Owner_Name__c', {
      isFormula: true,
      // A standard relationship whose object was never retrieved.
      formulaRelationshipRefs: ['Owner.Name', 'Missing__r.Whatever__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, formulaField], edges);
    expect(edges).toEqual([]);
  });

  it('mints nothing when the traversal resolves to an object that is vaulted but the FIELD is not', () => {
    const formulaField = field('Enrolment__c', 'Programme_Ghost__c', {
      isFormula: true,
      formulaRelationshipRefs: ['Programme__r.Not_Retrieved__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [LOOKUP, TARGET_FIELD, formulaField],
      edges,
    );
    expect(edges).toEqual([]);
  });
});

describe('mintRelationshipTraversalEdges — dynamic related-list columns', () => {
  it('scopes bare related-list aliases to the RELATED object, not the page object', () => {
    const page = flexiPage('Programme_Record_Page', {
      sobjectType: 'Programme__c',
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, page], edges);
    expect(edges).toHaveLength(1);
    // The page is on Programme__c, but the column belongs to Enrolment__c —
    // scoping it to the page's own sobjectType would have been wrong.
    expect(edges[0]?.toId).toBe('CustomField:Enrolment__c.Outcome__c');
    expect(edges[0]?.fromId).toBe('FlexiPage:Programme_Record_Page');
    expect(edges[0]?.confidence).toBe('declared');
    expect(edges[0]?.properties['relatedListApiName']).toBe('Enrolments__r');
  });

  it('skips standard pseudo-columns and dotted aliases it does not own', () => {
    const page = flexiPage('Programme_Record_Page', {
      sobjectType: 'Programme__c',
      relatedListFieldRefs: [
        {
          relatedListApiName: 'Enrolments__r',
          // NAME is a standard pseudo-column with no vaulted CustomField node;
          // the dotted alias is the generic sweep's business, not ours.
          fields: ['NAME', 'Other__c.Thing__c', 'Outcome__c'],
        },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, page], edges);
    expect(edges.map((e) => e.toId)).toEqual([
      'CustomField:Enrolment__c.Outcome__c',
    ]);
  });

  it('does not duplicate an edge the generic FlexiPage sweep already emitted', () => {
    // Found by running the resolver against a real org: a field that appears
    // BOTH as a direct fieldItem on the page and as a related-list alias column
    // produced two identical (from, to, references) rows. Two edges read as two
    // independent consumers when there is one page — the clone-propagation
    // double-count a field audit must never make.
    const page = flexiPage('Programme_Record_Page', {
      sobjectType: 'Programme__c',
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [
      {
        fromId: 'FlexiPage:Programme_Record_Page' as ComponentId,
        toId: 'CustomField:Enrolment__c.Outcome__c' as ComponentId,
        edgeType: 'references',
        confidence: 'heuristic',
        source: 'enterprise-metadata',
        properties: { referenceKind: 'fieldRef' },
      },
    ];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, page], edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe('enterprise-metadata');
  });

  it('mints nothing when the related list name is ambiguous across objects', () => {
    const rival = field('Withdrawal__c', 'Programme__c', {
      referenceTo: 'Programme__c',
      relationshipName: 'Enrolments',
    });
    const page = flexiPage('Programme_Record_Page', {
      sobjectType: 'Programme__c',
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, rival, CHILD_FIELD, page], edges);
    expect(edges).toEqual([]);
  });
});
