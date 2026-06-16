/**
 * FLD-05 — synthesize CustomField nodes from an org `sobject describe` snapshot.
 *
 * Standard-object fields (Account.Industry, Contact.Email, …) are NOT emitted
 * as separate `.field-meta.xml` files by a normal Metadata API retrieve — only
 * custom fields and customized standard fields land in source. A describe pass
 * at refresh time fills the gap for the five commonly-automated standard objects
 * so field tools can answer cross-domain questions without the live plane.
 *
 * Retrieved standard fields often ship as stub `.field-meta.xml` (type only, no
 * inline picklist values). The describe overlay ENRICHES those nodes instead of
 * skipping them when metadata is incomplete.
 *
 * Nodes are flagged `synthetic` + `provenance: 'org-describe-snapshot'` when
 * created or enriched from describe so consumers know the inventory is
 * org-specific and may differ by edition.
 */

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

/** Standard objects that receive a describe field snapshot (FLD-05). */
export const STANDARD_OBJECT_FIELD_SNAPSHOT = [
  'Account',
  'Contact',
  'Opportunity',
  'Lead',
  'Case',
] as const;

export type StandardObjectFieldSnapshotName =
  (typeof STANDARD_OBJECT_FIELD_SNAPSHOT)[number];

/** Active picklist entry from `sf sobject describe --json`. */
export interface DescribePicklistValue {
  readonly value?: string;
  readonly label?: string;
  readonly active?: boolean;
}

/** Minimal describe field row from `sf sobject describe --json`. */
export interface DescribeFieldRow {
  readonly name: string;
  readonly label?: string;
  readonly type?: string;
  readonly custom?: boolean;
  readonly nillable?: boolean;
  readonly inlineHelpText?: string;
  readonly picklistValues?: readonly DescribePicklistValue[];
}

const PICKLIST_DATA_TYPES = ['Picklist', 'MultiselectPicklist'] as const;

const FIELD_META_PATH_RE = /objects\/[^/]+\/fields\/[^/]+\.field-meta\.xml$/;

/** Map Salesforce describe `type` strings to the vault FieldType vocabulary. */
const DESCRIBE_TYPE_MAP: Readonly<Record<string, string>> = {
  string: 'Text',
  textarea: 'TextArea',
  email: 'Email',
  phone: 'Phone',
  url: 'Url',
  boolean: 'Checkbox',
  date: 'Date',
  datetime: 'DateTime',
  time: 'Time',
  int: 'Number',
  double: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  picklist: 'Picklist',
  multipicklist: 'MultiselectPicklist',
  reference: 'Lookup',
  id: 'Text',
  combobox: 'Picklist',
  encryptedstring: 'EncryptedText',
};

const mapDescribeType = (raw: string | undefined): string => {
  if (raw === undefined || raw.length === 0) return 'Unknown';
  const key = raw.toLowerCase();
  return DESCRIBE_TYPE_MAP[key] ?? 'Unknown';
};

const readPicklistValues = (
  props: Readonly<Record<string, unknown>>,
): readonly string[] | null => {
  const raw = props['picklistValues'];
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

const hasInlinePicklistValues = (node: Node): boolean => {
  const values = readPicklistValues(node.properties);
  return values !== null && values.length > 0;
};

/**
 * True when a live describe row should merge into an existing vault field —
 * stub/phantom nodes, or retrieved picklists missing declared values.
 */
export const fieldNeedsDescribeEnrichment = (existing: Node): boolean => {
  if (existing.properties['provenance'] === 'org-describe-snapshot') return false;
  const sourcePath = existing.sourcePath ?? '';
  if (FIELD_META_PATH_RE.test(sourcePath)) {
    const dataType = existing.properties['dataType'];
    if (
      typeof dataType === 'string' &&
      (PICKLIST_DATA_TYPES as readonly string[]).includes(dataType)
    ) {
      return !hasInlinePicklistValues(existing);
    }
    return false;
  }
  return true;
};

const extractDescribePicklistValues = (
  field: DescribeFieldRow,
): readonly string[] | null => {
  const entries = field.picklistValues;
  if (entries === undefined || entries.length === 0) return null;
  const values = entries
    .filter((entry) => entry.active !== false)
    .map((entry) => entry.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return values.length > 0 ? values : null;
};

const describePropertiesFromRow = (
  field: DescribeFieldRow,
): Readonly<Record<string, unknown>> => {
  const dataType = mapDescribeType(field.type);
  const picklistValues = extractDescribePicklistValues(field);
  const props: Record<string, unknown> = {
    label: field.label ?? field.name,
    dataType,
    custom: field.custom === true,
    synthetic: true,
    provenance: 'org-describe-snapshot',
    describeType: field.type ?? null,
  };
  if (field.nillable === false) props['required'] = true;
  if (typeof field.inlineHelpText === 'string' && field.inlineHelpText.length > 0) {
    props['inlineHelpText'] = field.inlineHelpText;
  }
  if (picklistValues !== null) props['picklistValues'] = picklistValues;
  return props;
};

const mergeDescribeOntoExisting = (
  existing: Node,
  field: DescribeFieldRow,
  objectApiName: string,
): Node => {
  const fromDescribe = describePropertiesFromRow(field);
  const merged: Record<string, unknown> = { ...existing.properties };
  for (const [key, value] of Object.entries(fromDescribe)) {
    if (key === 'picklistValues') {
      if (!hasInlinePicklistValues(existing) && value !== null) {
        merged[key] = value;
      }
      continue;
    }
    if (key === 'required' && existing.properties['required'] === true) continue;
    if (
      merged[key] === undefined ||
      merged[key] === null ||
      merged[key] === '' ||
      merged[key] === 'Unknown'
    ) {
      merged[key] = value;
    }
  }
  merged['describeEnriched'] = true;
  return {
    ...existing,
    label: existing.label ?? field.label ?? field.name,
    parentId: existing.parentId ?? (`CustomObject:${objectApiName}` as Node['parentId']),
    properties: merged,
  };
};

const createDescribeNode = (
  objectApiName: string,
  field: DescribeFieldRow,
  sourcePath: string,
): Node => {
  const parentId = `CustomObject:${objectApiName}`;
  const id = `CustomField:${objectApiName}.${field.name}`;
  return {
    id,
    type: 'CustomField',
    apiName: field.name,
    label: field.label ?? field.name,
    parentId,
    sourcePath,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: describePropertiesFromRow(field),
  };
};

/**
 * Build CustomField nodes (+ `parentOf` edges for new fields) from one object's
 * describe payload. Skips fields whose vault row is already complete; enriches
 * stub `.field-meta.xml` picklists and phantom references with describe facts.
 */
export const buildDescribeFieldExtraction = (
  objectApiName: string,
  describe: { readonly fields?: readonly DescribeFieldRow[] },
  existingById: ReadonlyMap<string, Node>,
): ExtractionResult => {
  const parentId = `CustomObject:${objectApiName}`;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const sourcePath = `describe-snapshot:${objectApiName}`;

  for (const field of describe.fields ?? []) {
    if (field.name.length === 0) continue;
    const id = `CustomField:${objectApiName}.${field.name}`;
    const existing = existingById.get(id);
    if (existing !== undefined && !fieldNeedsDescribeEnrichment(existing)) continue;

    const node =
      existing !== undefined
        ? mergeDescribeOntoExisting(existing, field, objectApiName)
        : createDescribeNode(objectApiName, field, sourcePath);
    nodes.push(node);

    if (existing === undefined) {
      edges.push({
        fromId: parentId,
        toId: id,
        edgeType: 'parentOf',
        confidence: 'declared',
        source: 'org-describe-snapshot',
        properties: {},
      });
    }
  }

  return { nodes, edges };
};

/** Collect every CustomField id already present in extraction results. */
export const existingCustomFieldIds = (
  results: readonly ExtractionResult[],
): Set<string> => {
  const ids = new Set<string>();
  for (const result of results) {
    for (const node of result.nodes) {
      if (node.type === 'CustomField') ids.add(node.id);
    }
  }
  return ids;
};

/** Map CustomField id → node for describe enrichment decisions. */
export const existingCustomFieldNodes = (
  results: readonly ExtractionResult[],
): Map<string, Node> => {
  const byId = new Map<string, Node>();
  for (const result of results) {
    for (const node of result.nodes) {
      if (node.type === 'CustomField') byId.set(node.id, node);
    }
  }
  return byId;
};

/**
 * Merge describe snapshots for `objects` into one overlay `ExtractionResult`.
 * Empty when every field was already retrieved from source.
 */
export const mergeDescribeFieldSnapshots = (
  snapshots: readonly ExtractionResult[],
): ExtractionResult => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const snap of snapshots) {
    nodes.push(...snap.nodes);
    edges.push(...snap.edges);
  }
  return { nodes, edges };
};
