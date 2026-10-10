/**
 * DLRS-ROLLUPS-UNMODELED: Declarative Lookup Rollup Summaries (the `dlrs`
 * managed package) defines each rollup as a `dlrs__LookupRollupSummary2__mdt`
 * custom metadata record — retrieved into the vault, but read only as opaque
 * key/value cells. So "what writes this field" answered "nothing" for a field a
 * real-time rollup recalculates on every child save, and a child field the
 * rollup aggregates could be certified deletable.
 *
 * This module turns one such record's values into graph edges, from the record
 * node:
 *
 *   writesTo  -> `CustomField:{ParentObject}.{AggregateResultField}` — the
 *                rollup target. `declared`: the record names it outright.
 *   readsFrom -> `CustomField:{ChildObject}.{field}` for the aggregated field,
 *                the relationship field, the criteria fields and the order-by
 *                fields (`roles` says which). `Id` (a COUNT's usual operand) is
 *                not a deletable field and mints nothing.
 *
 * Every edge carries `active` and `calculationMode`: an inactive rollup is
 * listed, never presented as a live writer. Nothing is guessed — a record
 * missing its parent object, child object or result field mints no edges.
 */

import type { Edge } from '@sf-intelligence/contracts';

/** Extractor `source` marker on every DLRS edge. */
export const DLRS_ROLLUP_SOURCE = 'dlrs-rollup';

/** The DLRS custom metadata type whose records define rollups. */
const DLRS_TYPE_RE = /^dlrs__LookupRollupSummary2(?:__mdt)?$/i;

/** A value cell as the custom-metadata-record extractor parses it. */
export interface DlrsValueCell {
  readonly field: string;
  readonly value: string | number | boolean | null;
}

/** True when a CustomMetadataRecord of this type is a DLRS rollup definition. */
export const isDlrsRollupType = (typeApiName: string): boolean =>
  DLRS_TYPE_RE.test(typeApiName);

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Split a free-text field list (`A__c, B__c` or one per line) into api names. */
const splitFieldList = (raw: string): string[] =>
  raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => IDENT.test(t) && !/^(asc|desc|nulls|first|last)$/i.test(t));

/**
 * Build the DLRS rollup edges for one record. Returns `[]` for a record that
 * does not name a parent object, child object and result field.
 */
export const buildDlrsRollupEdges = (
  nodeId: string,
  values: readonly DlrsValueCell[],
): Edge[] => {
  const cell = (name: string): string | number | boolean | null => {
    const hit = values.find((v) => v.field.toLowerCase() === `dlrs__${name}__c`.toLowerCase());
    return hit === undefined ? null : hit.value;
  };
  const text = (name: string): string | null => {
    const v = cell(name);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };
  const parentObject = text('ParentObject');
  const childObject = text('ChildObject');
  const resultField = text('AggregateResultField');
  if (
    parentObject === null ||
    childObject === null ||
    resultField === null ||
    !IDENT.test(parentObject) ||
    !IDENT.test(childObject) ||
    !IDENT.test(resultField)
  ) {
    return [];
  }
  const activeRaw = cell('Active');
  const active = activeRaw === true || (typeof activeRaw === 'string' && activeRaw.toLowerCase() === 'true');
  const calculationMode = text('CalculationMode');
  const aggregateOperation = text('AggregateOperation');
  const fieldToAggregate = text('FieldToAggregate');
  const relationshipField = text('RelationshipField');
  const shared = {
    mechanism: 'dlrs-rollup',
    active,
    ...(calculationMode !== null ? { calculationMode } : {}),
  };

  const edges: Edge[] = [
    {
      fromId: nodeId,
      toId: `CustomField:${parentObject}.${resultField}`,
      edgeType: 'writesTo',
      confidence: 'declared',
      source: DLRS_ROLLUP_SOURCE,
      properties: {
        ...shared,
        assignedValueKind: 'rollup',
        childObject,
        ...(aggregateOperation !== null ? { aggregateOperation } : {}),
        ...(fieldToAggregate !== null ? { fieldToAggregate } : {}),
        ...(relationshipField !== null ? { relationshipField } : {}),
      },
    },
  ];

  // child field -> roles; one readsFrom per field (the graph PK has no role).
  const reads = new Map<string, Set<string>>();
  const addRead = (field: string | null, role: string): void => {
    if (field === null || !IDENT.test(field) || field.toLowerCase() === 'id') return;
    const roles = reads.get(field) ?? new Set<string>();
    roles.add(role);
    reads.set(field, roles);
  };
  addRead(fieldToAggregate, 'aggregated');
  addRead(relationshipField, 'relationship');
  for (const f of splitFieldList(text('RelationshipCriteriaFields') ?? '')) addRead(f, 'criteria');
  for (const f of splitFieldList(text('FieldToOrderBy') ?? '')) addRead(f, 'orderBy');
  for (const [field, roles] of [...reads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    edges.push({
      fromId: nodeId,
      toId: `CustomField:${childObject}.${field}`,
      edgeType: 'readsFrom',
      confidence: 'declared',
      source: DLRS_ROLLUP_SOURCE,
      properties: { ...shared, roles: [...roles].sort(), parentField: `${parentObject}.${resultField}` },
    });
  }
  return edges;
};
