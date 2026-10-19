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

const conditionalContext = (
  apiName: string,
  properties: Record<string, unknown>,
): Node => ({
  id: `ConditionalContext:${apiName}` as ComponentId,
  type: 'ConditionalContext',
  apiName,
  label: null,
  parentId: null,
  sourcePath: `conditions/${apiName}.xml`,
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

const layout = (
  objectApiName: string,
  layoutName: string,
  properties: Record<string, unknown>,
): Node => ({
  id: `Layout:${objectApiName}.${layoutName}` as ComponentId,
  type: 'Layout',
  apiName: layoutName,
  label: layoutName,
  parentId: `CustomObject:${objectApiName}` as ComponentId,
  sourcePath: `layouts/${objectApiName}-${layoutName}.layout-meta.xml`,
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
    // Classic page layouts name the same list object-qualified: `{Child}.{LookupField}`.
    expect(maps.childward.get('enrolment__c.programme__c')).toBe('Enrolment__c');
  });

  it('indexes a managed-package child relationship under its namespaced runtime spelling', () => {
    // FAIL-BEFORE: a packaged lookup declares `relationshipName` WITHOUT its
    // namespace (`Enrolments`), but every report-type `<table>` path, related
    // list and SOQL spells it `pkg__Enrolments__r`, so 2,572 report-type columns
    // on a real org fell through as unresolved.
    const packaged = field('pkg__Enrolment__c', 'pkg__Programme__c', {
      referenceTo: 'Programme__c',
      relationshipName: 'Enrolments',
    });
    const maps = buildRelationshipMaps([packaged]);
    expect(maps.childward.get('pkg__enrolments__r')).toBe('pkg__Enrolment__c');
    expect(maps.childward.get('pkg__enrolments')).toBe('pkg__Enrolment__c');
    // The un-prefixed spelling stays indexed too.
    expect(maps.childward.get('enrolments')).toBe('pkg__Enrolment__c');
  });

  it('drops an ambiguous child relationship name rather than picking one', () => {
    const rival = field('Withdrawal__c', 'Programme__c', {
      referenceTo: 'Programme__c',
      relationshipName: 'Enrolments',
    });
    const maps = buildRelationshipMaps([LOOKUP, rival]);
    expect(maps.childward.has('enrolments__r')).toBe(false);
    // The parentward direction is keyed by owning object, so THIS pair stays
    // unambiguous — two objects each get their own key.
    expect(maps.parentward.get('withdrawal__c|programme__r')).toBe('Programme__c');
  });

  it('drops a parentward key whose traversal resolves to two different objects', () => {
    // FAIL-BEFORE: parentward was last-writer-wins with no guard, so this key
    // silently took whichever lookup the node array happened to end on — while
    // the module doc asserted `resolve or drop, never guess`. A guessed hop is
    // worse than a dropped one: it retargets EVERY traversal that walks through
    // it, minting an edge onto a field the formula never read.
    //
    // The collision is reachable because the key is lower-cased: two fields on
    // one object differing only in case share a key. (Probed against the
    // reference vault: 323 lookup/master-detail fields produced 323 distinct
    // parentward keys and ZERO collisions — this guard is about holding the
    // contract, not about repairing that vault.)
    const upper = field('Enrolment__c', 'Sponsor__c', {
      referenceTo: 'Organisation__c',
    });
    const lower = field('Enrolment__c', 'sponsor__c', {
      referenceTo: 'Person__c',
    });
    expect(buildRelationshipMaps([upper, lower]).parentward.has('enrolment__c|sponsor__r')).toBe(false);
    // Order-independent — a drop, not a race the caller could win by sorting.
    expect(buildRelationshipMaps([lower, upper]).parentward.has('enrolment__c|sponsor__r')).toBe(false);
  });

  it('keeps a duplicated parentward key when both lookups agree on the target', () => {
    // Only a DISAGREEING target is ambiguous. Two spellings that land on the
    // same object resolve identically either way, so dropping them would lose a
    // resolvable hop for no honesty gain.
    const upper = field('Enrolment__c', 'Sponsor__c', {
      referenceTo: 'Organisation__c',
    });
    const lower = field('Enrolment__c', 'sponsor__c', {
      referenceTo: 'Organisation__c',
    });
    const maps = buildRelationshipMaps([upper, lower]);
    expect(maps.parentward.get('enrolment__c|sponsor__r')).toBe('Organisation__c');
  });
});

describe('mintRelationshipTraversalEdges — confidence tiers', () => {
  it('stamps BOTH branches `parsed` — neither is a declared pointer', () => {
    // GUARD against the asymmetry that shipped: the formula branch stamped
    // `parsed` while the related-list alias branch stamped `declared`, though
    // both are a scrape plus a join through the same inferred relationship map.
    // `declared` is the tier a caller trusts most when deciding to delete a
    // field, so an inferred join must not borrow it. Asserting both in ONE test
    // means the pair cannot silently drift apart again.
    const formulaField = field('Enrolment__c', 'Programme_Status__c', {
      isFormula: true,
      formulaRelationshipRefs: ['Programme__r.Status__c'],
    });
    const page = flexiPage('Programme_Record_Page', {
      sobjectType: 'Programme__c',
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [LOOKUP, TARGET_FIELD, CHILD_FIELD, formulaField, page],
      edges,
    );
    expect(edges).toHaveLength(2);
    const byKind = new Map(
      edges.map((e) => [e.properties['referenceKind'], e.confidence]),
    );
    expect(byKind.get('formulaRelationshipTraversal')).toBe('parsed');
    expect(byKind.get('relatedListFieldAlias')).toBe('parsed');
    // Stated as a set too, so a future third branch cannot slip in `declared`.
    expect(new Set(edges.map((e) => e.confidence))).toEqual(new Set(['parsed']));
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
    // Parsed, not declared: regex-scraped XML column resolved through the
    // INFERRED childward map. See the both-branches confidence guard below.
    expect(edges[0]?.confidence).toBe('parsed');
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

describe('mintRelationshipTraversalEdges — layout related-list columns', () => {
  it('mints usedInLayout on the child object when the relationship resolves', () => {
    const pageLayout = layout('Programme__c', 'Programme Layout', {
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [LOOKUP, CHILD_FIELD, pageLayout],
      edges,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeType).toBe('usedInLayout');
    expect(edges[0]?.toId).toBe('CustomField:Enrolment__c.Outcome__c');
    expect(edges[0]?.fromId).toBe('Layout:Programme__c.Programme Layout');
    expect(edges[0]?.confidence).toBe('parsed');
    expect(edges[0]?.properties['referenceKind']).toBe('layoutRelatedListColumn');
  });

  it('resolves the Classic object-qualified spelling ({Child}.{LookupField}) a page layout uses', () => {
    // FAIL-BEFORE: the childward index knew only the relationship name, so every
    // Classic layout list (`Enrolment__c.Programme__c`) fell into unresolved and
    // the item minted nothing on real page layouts.
    const pageLayout = layout('Programme__c', 'Programme Layout', {
      relatedListFieldRefs: [
        { relatedListApiName: 'Enrolment__c.Programme__c', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, pageLayout], edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toId).toBe('CustomField:Enrolment__c.Outcome__c');
    expect(pageLayout.properties['unresolvedRelatedLists']).toBeUndefined();
  });

  it('records unresolvedRelatedLists for a standard relationship and mints nothing', () => {
    const pageLayout = layout('Programme__c', 'Programme Layout', {
      relatedListFieldRefs: [
        { relatedListApiName: 'RelatedActivityList', fields: ['TASK.SUBJECT'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, pageLayout], edges);
    expect(edges).toEqual([]);
    expect(pageLayout.properties['unresolvedRelatedLists']).toEqual([
      'RelatedActivityList',
    ]);
  });

  it('omits related lists with no columns from relatedListFieldRefs handling', () => {
    const pageLayout = layout('Programme__c', 'Programme Layout', {
      relatedListFieldRefs: [],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, pageLayout], edges);
    expect(edges).toEqual([]);
    expect(pageLayout.properties['unresolvedRelatedLists']).toBeUndefined();
  });
});

describe('mintRelationshipTraversalEdges — condition relationship traversals', () => {
  it('resolves a condition traversal onto the REAL field, as a readsFrom at parsed', () => {
    const ctx = conditionalContext('VR_Enrolment_Blocked', {
      objectApiName: 'Enrolment__c',
      unresolvedTraversalRefs: ['Programme__r.Status__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, ctx], edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.fromId).toBe('ConditionalContext:VR_Enrolment_Blocked');
    // The whole point: the edge lands on the field that EXISTS, not on
    // `CustomField:Programme__r.Status__c`, which names no node and never could.
    expect(edges[0]?.toId).toBe('CustomField:Programme__c.Status__c');
    expect(edges[0]?.edgeType).toBe('readsFrom');
    expect(edges[0]?.confidence).toBe('parsed');
    expect(edges[0]?.properties['referenceKind']).toBe('conditionRelationshipTraversal');
    expect(edges[0]?.properties['traversalPath']).toBe('Programme__r.Status__c');
  });

  it('walks a multi-hop condition traversal', () => {
    const faculty = field('Programme__c', 'Faculty__c', {
      referenceTo: 'Faculty__c',
      relationshipName: 'Programmes',
    });
    const facultyCode = field('Faculty__c', 'Code__c', {});
    const ctx = conditionalContext('Flow_Decision_A', {
      objectApiName: 'Enrolment__c',
      unresolvedTraversalRefs: ['Programme__r.Faculty__r.Code__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, faculty, facultyCode, ctx], edges);
    expect(edges.map((e) => e.toId)).toEqual(['CustomField:Faculty__c.Code__c']);
  });

  it('RESOLVE OR DROP: an unresolvable hop mints NOTHING, never a dangling id', () => {
    const ctx = conditionalContext('Flow_Decision_B', {
      objectApiName: 'Enrolment__c',
      unresolvedTraversalRefs: ['Missing__r.Whatever__c', 'Owner.Name'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, ctx], edges);
    expect(edges).toEqual([]);
  });

  it('mints nothing when the relationship key is AMBIGUOUS (never picks one)', () => {
    // Two lookups on Enrolment__c whose traversal spelling collides on
    // different targets — buildRelationshipMaps drops the key.
    const dupe = field('Enrolment__c', 'programme__c', {
      referenceTo: 'Archive__c',
      relationshipName: 'ArchivedEnrolments',
    });
    const ctx = conditionalContext('Flow_Decision_C', {
      objectApiName: 'Enrolment__c',
      unresolvedTraversalRefs: ['Programme__r.Status__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, dupe, TARGET_FIELD, ctx], edges);
    expect(edges).toEqual([]);
  });

  it('mints nothing without the objectApiName resolution base', () => {
    const ctx = conditionalContext('Flow_Decision_D', {
      unresolvedTraversalRefs: ['Programme__r.Status__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, ctx], edges);
    expect(edges).toEqual([]);
  });

  it('a readsFrom is NOT suppressed by a pre-existing references edge on the same pair', () => {
    // The dedup key carries the edge type; before the fix `emit` hardcoded
    // `references` in the key and this readsFrom would have been swallowed.
    const ctx = conditionalContext('VR_Enrolment_Blocked', {
      objectApiName: 'Enrolment__c',
      unresolvedTraversalRefs: ['Programme__r.Status__c'],
    });
    const edges: Edge[] = [
      {
        fromId: 'ConditionalContext:VR_Enrolment_Blocked' as ComponentId,
        toId: 'CustomField:Programme__c.Status__c' as ComponentId,
        edgeType: 'references',
        confidence: 'heuristic',
        source: 'someone-else',
        properties: {},
      } as Edge,
    ];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, ctx], edges);
    expect(edges).toHaveLength(2);
    expect(edges[1]?.edgeType).toBe('readsFrom');
  });
});

const omniNode = (type: 'OmniDataTransform' | 'OmniUiCard', apiName: string, properties: Record<string, unknown>): Node => ({
  id: `${type}:${apiName}` as ComponentId,
  type,
  apiName,
  label: null,
  parentId: null,
  sourcePath: `omni/${apiName}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

describe('mintRelationshipTraversalEdges — DataMapper and FlexCard paths', () => {
  it('resolves an Extract read and a Load write onto the real field, by access', () => {
    const dm = omniNode('OmniDataTransform', 'AcmeEnrolmentMapper_1', {
      unresolvedTraversalRefs: [
        { object: 'Enrolment__c', path: 'Programme__r.Status__c', access: 'read' },
        { object: 'Enrolment__c', path: 'Programme__r.Status__c', access: 'write' },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, dm], edges);
    expect(edges.map((e) => [e.edgeType, e.toId, e.confidence, e.properties['referenceKind']])).toEqual([
      ['readsFrom', 'CustomField:Programme__c.Status__c', 'parsed', 'dataMapperRelationshipTraversal'],
      ['writesTo', 'CustomField:Programme__c.Status__c', 'parsed', 'dataMapperRelationshipTraversal'],
    ]);
  });

  it('resolves a FlexCard SOQL path, and mints nothing for an unknown relationship', () => {
    const card = omniNode('OmniUiCard', 'AcmeEnrolmentCard_1', {
      unresolvedTraversalRefs: [
        { object: 'Enrolment__c', path: 'Programme__r.Status__c', access: 'read' },
        { object: 'Enrolment__c', path: 'Nowhere__r.Status__c', access: 'read' },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, card], edges);
    expect(edges.map((e) => [e.fromId, e.toId])).toEqual([
      ['OmniUiCard:AcmeEnrolmentCard_1', 'CustomField:Programme__c.Status__c'],
    ]);
  });
});

const reportType = (apiName: string, properties: Record<string, unknown>): Node => ({
  id: `ReportType:${apiName}` as ComponentId,
  type: 'ReportType',
  apiName,
  label: null,
  parentId: null,
  sourcePath: `reportTypes/${apiName}.reportType-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const fieldSet = (objectApiName: string, apiName: string, properties: Record<string, unknown>): Node => ({
  id: `FieldSet:${objectApiName}.${apiName}` as ComponentId,
  type: 'FieldSet',
  apiName,
  label: apiName,
  parentId: `CustomObject:${objectApiName}` as ComponentId,
  sourcePath: `objects/${objectApiName}/fieldSets/${apiName}.fieldSet-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

describe('mintRelationshipTraversalEdges — report-type columns', () => {
  // FAIL-BEFORE: the generic sweep minted `CustomField:<Lookup__c>.<Field>` and
  // nothing for a `<table>` relationship path, so a report type built over a
  // child object named none of that object's fields.
  it('a column on the base table is a declared edge to that object’s field', () => {
    const rt = reportType('Demo_Programmes', {
      columnRefs: [{ table: 'Programme__c', fields: ['Status__c'] }],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, rt], edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromId: 'ReportType:Demo_Programmes',
      toId: 'CustomField:Programme__c.Status__c',
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'reportTypeColumn', table: 'Programme__c' },
    });
  });

  it('walks a `<table>` relationship path to the child object (both relationship spellings)', () => {
    const rt = reportType('Demo_Programmes_with_Enrolments', {
      columnRefs: [
        { table: 'Programme__c.Enrolments', fields: ['Outcome__c'] },
        { table: 'Programme__c.Enrolments__r', fields: ['Outcome__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, CHILD_FIELD, rt], edges);
    // One edge: the same (from, to, type) triple is not minted twice.
    expect(edges.map((e) => [e.toId, e.confidence])).toEqual([
      ['CustomField:Enrolment__c.Outcome__c', 'parsed'],
    ]);
    expect(rt.properties['unresolvedColumns']).toBeUndefined();
  });

  it('resolves a dotted `<field>` whose hop is spelled as the lookup FIELD (`Programme__c.Status__c`)', () => {
    const rt = reportType('Demo_Enrolments', {
      columnRefs: [{ table: 'Programme__c.Enrolments', fields: ['Programme__c.Status__c'] }],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, rt], edges);
    expect(edges.map((e) => [e.toId, e.confidence])).toEqual([
      ['CustomField:Programme__c.Status__c', 'parsed'],
    ]);
  });

  it('records unresolvedColumns for a hop it cannot walk and mints nothing', () => {
    const rt = reportType('Demo_Programmes_with_Owners', {
      columnRefs: [
        { table: 'Programme__c.Owner_Users', fields: ['Name'] },
        { table: 'Programme__c', fields: ['Owner.Name', 'Status__c'] },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, rt], edges);
    expect(edges.map((e) => e.toId)).toEqual(['CustomField:Programme__c.Status__c']);
    expect(rt.properties['unresolvedColumns']).toEqual([
      'Programme__c.Owner.Name',
      'Programme__c.Owner_Users.Name',
    ]);
  });

  it('mints nothing for a column whose object resolves but whose field is not vaulted', () => {
    const rt = reportType('Demo_Programmes', {
      columnRefs: [{ table: 'Programme__c', fields: ['Nope__c'] }],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, rt], edges);
    expect(edges).toEqual([]);
    expect(rt.properties['unresolvedColumns']).toBeUndefined();
  });
});

describe('mintRelationshipTraversalEdges — field-set relationship columns', () => {
  // FAIL-BEFORE: `<displayedFields><field>Programme__r.Status__c</field>` minted
  // `CustomField:Enrolment__c.Programme__r.Status__c`, an id no node has.
  it('resolves a dotted displayed field onto the related object, as usedInLayout at parsed', () => {
    const fs = fieldSet('Enrolment__c', 'Demo_Table', {
      unresolvedTraversalRefs: ['Programme__r.Status__c', 'Nowhere__r.Status__c'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, fs], edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromId: 'FieldSet:Enrolment__c.Demo_Table',
      toId: 'CustomField:Programme__c.Status__c',
      edgeType: 'usedInLayout',
      confidence: 'parsed',
      properties: { referenceKind: 'fieldSetRelationshipTraversal', traversalPath: 'Programme__r.Status__c' },
    });
  });
});

const bundle = (type: 'LightningComponentBundle' | 'AuraDefinitionBundle', apiName: string): Node => ({
  id: `${type}:${apiName}` as ComponentId,
  type,
  apiName,
  label: null,
  parentId: null,
  sourcePath: `${type === 'LightningComponentBundle' ? 'lwc' : 'aura'}/${apiName}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

describe('mintRelationshipTraversalEdges — Lightning page record traversals', () => {
  it('resolves {!Record.Rel__r.Field} through the page object: visibility reads, fieldItem references', () => {
    const page = flexiPage('Enrolment_Record_Page', {
      sobjectType: 'Enrolment__c',
      recordTraversalRefs: [
        { path: 'Programme__r.Status__c', use: 'visibilityRule' },
        { path: 'Programme__r.Status__c', use: 'fieldRef' },
        { path: 'Owner.Name', use: 'visibilityRule' },
      ],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges([LOOKUP, TARGET_FIELD, page], edges);
    expect(
      edges.map((e) => [e.edgeType, e.toId, e.confidence, e.properties['referenceKind'], e.properties['traversalPath']]),
    ).toEqual([
      ['readsFrom', 'CustomField:Programme__c.Status__c', 'parsed', 'visibilityRule', 'Record.Programme__r.Status__c'],
      ['references', 'CustomField:Programme__c.Status__c', 'parsed', 'fieldRef', 'Record.Programme__r.Status__c'],
    ]);
    // `Owner` is a standard relationship the vault holds no lookup for: recorded, never minted.
    expect(page.properties['unresolvedVisibilityRefs']).toEqual(['Record.Owner.Name']);
  });

  it('appends to unresolvedVisibilityRefs the extractor already recorded', () => {
    const page = flexiPage('Enrolment_Record_Page', {
      sobjectType: 'Enrolment__c',
      unresolvedVisibilityRefs: ['Record.Gone__c'],
      recordTraversalRefs: [{ path: 'Nowhere__r.X__c', use: 'visibilityRule' }],
    });
    mintRelationshipTraversalEdges([LOOKUP, page], []);
    expect(page.properties['unresolvedVisibilityRefs']).toEqual(['Record.Gone__c', 'Record.Nowhere__r.X__c']);
  });
});

describe('mintRelationshipTraversalEdges — Lightning page component placements', () => {
  it('mints a declared references edge to whichever bundle the name resolves to, and records the rest', () => {
    const page = flexiPage('Enrolment_Record_Page', {
      sobjectType: 'Enrolment__c',
      componentRefs: ['DemoPanel', 'demoCard', 'ghostCmp'],
    });
    const edges: Edge[] = [];
    mintRelationshipTraversalEdges(
      [bundle('LightningComponentBundle', 'demoCard'), bundle('AuraDefinitionBundle', 'DemoPanel'), page],
      edges,
    );
    expect(edges.map((e) => [e.fromId, e.toId, e.edgeType, e.confidence, e.properties['referenceKind']])).toEqual([
      ['FlexiPage:Enrolment_Record_Page', 'AuraDefinitionBundle:DemoPanel', 'references', 'declared', 'componentPlacement'],
      ['FlexiPage:Enrolment_Record_Page', 'LightningComponentBundle:demoCard', 'references', 'declared', 'componentPlacement'],
    ]);
    expect(page.properties['unresolvedComponentRefs']).toEqual(['ghostCmp']);
  });
});
