import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';

import { extractCustomMetadataRecord } from './custom-metadata-record.js';
import { extractCustomSettingRecord } from './custom-setting-record.js';

const EXTRACTOR_SOURCE = 'cpq-extractor';

/**
 * The five CPQ ComponentType names that the recognition layer emits.
 * Used as the key set for `PROPERTY_DERIVATIONS` and the typed return
 * from `recognizeCpqType`.
 */
type CpqComponentType =
  | 'CpqProductRule'
  | 'CpqPriceRule'
  | 'CpqQuoteTemplate'
  | 'CpqLookupQuery'
  | 'CpqConfigurationAttribute';

/**
 * The five CPQ object-type prefixes v2.6a recognizes against the
 * underlying record's apiName.
 *
 * Each prefix maps a CustomMetadataRecord or CustomSettingRecord whose
 * apiName begins with the given string to the named CPQ ComponentType.
 * The recognition is purely structural — the SBQQ__ managed-package
 * namespace is the fingerprint, not a declared Salesforce metadata
 * marker. Confidence on every emission is `heuristic` per the
 * v2.1 recognizer convention.
 */
const CPQ_RECOGNITION_RULES: ReadonlyArray<{
  readonly prefix: string;
  readonly type: CpqComponentType;
}> = [
  { prefix: 'SBQQ__ProductRule__c', type: 'CpqProductRule' },
  { prefix: 'SBQQ__PriceRule__c', type: 'CpqPriceRule' },
  { prefix: 'SBQQ__QuoteTemplate__c', type: 'CpqQuoteTemplate' },
  { prefix: 'SBQQ__LookupQuery__c', type: 'CpqLookupQuery' },
  {
    prefix: 'SBQQ__ConfigurationAttribute__c',
    type: 'CpqConfigurationAttribute',
  },
];

/**
 * Per-CPQ-type derivation map. Each entry pairs a property name on the
 * emitted CPQ node with the SBQQ field apiName the underlying record's
 * values mirror should be searched against. Boolean properties default
 * to `false` when absent so the runtime semantics (a checkbox unset is
 * `false`, not `null`) round-trip cleanly; non-boolean properties
 * default to `null`.
 *
 * The derivation rule is uniform — see CpqSemantics.md §3.6.
 */
interface PropertyDerivation {
  readonly outputProperty: string;
  readonly sourceField: string;
  readonly defaultToFalse: boolean;
}

const COMMON_PRODUCT_PRICE_RULE_PROPS: readonly PropertyDerivation[] = [
  {
    outputProperty: 'conditionsMet',
    sourceField: 'SBQQ__ConditionsMet__c',
    defaultToFalse: false,
  },
  {
    outputProperty: 'evaluationOrder',
    sourceField: 'SBQQ__EvaluationOrder__c',
    defaultToFalse: false,
  },
  {
    outputProperty: 'active',
    sourceField: 'SBQQ__Active__c',
    defaultToFalse: true,
  },
];

const PROPERTY_DERIVATIONS: Readonly<
  Record<CpqComponentType, readonly PropertyDerivation[]>
> = {
  CpqProductRule: [
    ...COMMON_PRODUCT_PRICE_RULE_PROPS,
    {
      outputProperty: 'productLookup',
      sourceField: 'SBQQ__ProductLookup__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'lookupObject',
      sourceField: 'SBQQ__LookupObject__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'type',
      sourceField: 'SBQQ__Type__c',
      defaultToFalse: false,
    },
  ],
  CpqPriceRule: [
    ...COMMON_PRODUCT_PRICE_RULE_PROPS,
    {
      outputProperty: 'calculatorEvaluationEvent',
      sourceField: 'SBQQ__CalculatorEvaluationEvent__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'evaluationScope',
      sourceField: 'SBQQ__EvaluationScope__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'lookupObject',
      sourceField: 'SBQQ__LookupObject__c',
      defaultToFalse: false,
    },
  ],
  CpqQuoteTemplate: [
    {
      outputProperty: 'templateContentReference',
      sourceField: 'SBQQ__Template__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'active',
      sourceField: 'SBQQ__Active__c',
      defaultToFalse: true,
    },
    {
      outputProperty: 'defaultTemplate',
      sourceField: 'SBQQ__DefaultTemplate__c',
      defaultToFalse: true,
    },
    {
      outputProperty: 'pageBreakBefore',
      sourceField: 'SBQQ__PageBreakBefore__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'documentFormat',
      sourceField: 'SBQQ__DocumentFormat__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'landscape',
      sourceField: 'SBQQ__Landscape__c',
      defaultToFalse: true,
    },
  ],
  CpqLookupQuery: [
    {
      outputProperty: 'priceRule',
      sourceField: 'SBQQ__PriceRule__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'matchType',
      sourceField: 'SBQQ__MatchType__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'field',
      sourceField: 'SBQQ__Field__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'value',
      sourceField: 'SBQQ__Value__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'tested',
      sourceField: 'SBQQ__Tested__c',
      defaultToFalse: true,
    },
  ],
  CpqConfigurationAttribute: [
    {
      outputProperty: 'targetField',
      sourceField: 'SBQQ__TargetField__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'position',
      sourceField: 'SBQQ__Position__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'applyImmediatelyContext',
      sourceField: 'SBQQ__ApplyImmediatelyContext__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'displayOrder',
      sourceField: 'SBQQ__DisplayOrder__c',
      defaultToFalse: false,
    },
    {
      outputProperty: 'required',
      sourceField: 'SBQQ__Required__c',
      defaultToFalse: true,
    },
    {
      outputProperty: 'product',
      sourceField: 'SBQQ__Product__c',
      defaultToFalse: false,
    },
  ],
};

/**
 * One field/value tuple in the underlying record's values mirror. The
 * shape mirrors the v1.6 R2 extractors' `ValueEntry` so consumers can
 * round-trip a CPQ node back to its underlying CMD/CSR record without
 * re-reading the source XML.
 */
interface ValueEntry {
  readonly field: string;
  readonly value: string | number | boolean | null;
  readonly valueType: 'number' | 'string' | 'boolean' | 'null' | 'unknown';
  readonly isMasked: boolean;
}

/**
 * Decide whether a record's apiName matches one of the five v2.6a CPQ
 * prefixes. Returns the recognized CPQ ComponentType or `null` for non-
 * CPQ records.
 */
const recognizeCpqType = (apiName: string): CpqComponentType | null => {
  for (const { prefix, type } of CPQ_RECOGNITION_RULES) {
    if (apiName.startsWith(prefix)) return type;
  }
  return null;
};

/**
 * Derive a single property from the underlying record's values mirror.
 * Returns the field's value verbatim when found, `null` (or `false`
 * when `defaultToFalse`) otherwise. Masked values per v1.6's
 * `isMasked: true` shape collapse to the default — the recognition
 * layer MUST NOT fabricate the underlying value.
 */
const deriveProperty = (
  values: readonly ValueEntry[],
  derivation: PropertyDerivation,
): string | number | boolean | null => {
  const entry = values.find((v) => v.field === derivation.sourceField);
  if (entry === undefined) {
    return derivation.defaultToFalse ? false : null;
  }
  if (entry.isMasked) {
    return derivation.defaultToFalse ? false : null;
  }
  if (entry.value === null) {
    return derivation.defaultToFalse ? false : null;
  }
  return entry.value;
};

/**
 * Extract the values mirror from an underlying record node's
 * `properties.values`. Tolerates the property being absent or
 * malformed (returns an empty array) — every v1.6 R2 extractor emits a
 * `values: []` even for empty records, so a missing property indicates
 * an upstream extraction issue rather than a record with no fields.
 */
const readValuesMirror = (record: Node): readonly ValueEntry[] => {
  const raw = record.properties['values'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
    )
    .map(
      (entry): ValueEntry => ({
        field: typeof entry['field'] === 'string' ? entry['field'] : '',
        value: entry['value'] as ValueEntry['value'],
        valueType:
          typeof entry['valueType'] === 'string'
            ? (entry['valueType'] as ValueEntry['valueType'])
            : 'unknown',
        isMasked: entry['isMasked'] === true,
      }),
    );
};

/**
 * Build the CPQ-typed sibling node for a recognized record. Carries
 * the same apiName / label / parentId / sourcePath as the underlying
 * record (preserves provenance), the per-type derived properties, the
 * full values mirror, and the recognition-axis bookkeeping
 * (`recognitionConfidence`, `underlyingRecordId`).
 */
const buildCpqNode = (
  underlyingRecord: Node,
  cpqType: CpqComponentType,
): Node => {
  const values = readValuesMirror(underlyingRecord);
  const derivations = PROPERTY_DERIVATIONS[cpqType];
  const derivedProperties: Record<string, unknown> = {};
  for (const derivation of derivations) {
    derivedProperties[derivation.outputProperty] = deriveProperty(
      values,
      derivation,
    );
  }
  return {
    id: `${cpqType}:${underlyingRecord.apiName}`,
    type: cpqType,
    apiName: underlyingRecord.apiName,
    label: underlyingRecord.label,
    parentId: underlyingRecord.parentId,
    sourcePath: underlyingRecord.sourcePath,
    lastModifiedDate: underlyingRecord.lastModifiedDate,
    lastModifiedBy: underlyingRecord.lastModifiedBy,
    apiVersion: underlyingRecord.apiVersion,
    properties: {
      ...derivedProperties,
      values,
      recognitionConfidence: 'heuristic',
      underlyingRecordId: underlyingRecord.id,
    },
  };
};

/**
 * Build the `parentOf` edge connecting the underlying CustomObject
 * (the SBQQ__-prefixed type definition) to the new CPQ node. Mirrors
 * the v1.6 CustomField → CustomObject pattern; no new EdgeType is
 * introduced. Confidence `heuristic` per the v2.6a recognition axis.
 */
const buildParentEdge = (
  underlyingRecord: Node,
  cpqNodeId: string,
): Edge | null => {
  if (underlyingRecord.parentId === null) return null;
  return {
    fromId: underlyingRecord.parentId,
    toId: cpqNodeId,
    edgeType: 'parentOf',
    confidence: 'heuristic',
    source: EXTRACTOR_SOURCE,
    properties: {},
  };
};

/**
 * Specialize a v1.6 underlying-record `ExtractionResult` by recognizing
 * any CPQ-prefixed records and emitting sibling CPQ-typed nodes plus
 * their `parentOf` edges. Non-CPQ records pass through unchanged. The
 * input result's nodes and edges are preserved verbatim; the
 * specialization layer only ADDS nodes and edges, never removes or
 * mutates.
 *
 * @example
 *   const underlying = await extractCustomMetadataRecord(path);
 *   if (underlying.ok) {
 *     const specialized = specializeCpq(underlying.value);
 *     // specialized.nodes now contains the original CMD node plus the
 *     // CpqPriceRule sibling node when the apiName matched.
 *   }
 */
export const specializeCpq = (
  underlying: ExtractionResult,
): ExtractionResult => {
  const extraNodes: Node[] = [];
  const extraEdges: Edge[] = [];
  for (const node of underlying.nodes) {
    if (
      node.type !== 'CustomMetadataRecord' &&
      node.type !== 'CustomSettingRecord'
    ) {
      continue;
    }
    const cpqType = recognizeCpqType(node.apiName);
    if (cpqType === null) continue;
    const cpqNode = buildCpqNode(node, cpqType);
    extraNodes.push(cpqNode);
    const edge = buildParentEdge(node, cpqNode.id);
    if (edge !== null) extraEdges.push(edge);
  }
  return {
    nodes: [...underlying.nodes, ...extraNodes],
    edges: [...underlying.edges, ...extraEdges],
  };
};

/**
 * Extract a CPQ-specialized result from a Custom Metadata record file
 * (`.md-meta.xml`). Calls the underlying v1.6 R2 extractor and then
 * applies the v2.6a specialization layer. Non-CPQ records (any
 * apiName without an `SBQQ__` recognition prefix) round-trip through
 * unchanged — the same nodes and edges the underlying extractor
 * emitted.
 *
 * Returns the same `ExtractorError` shapes the underlying extractor
 * surfaces — file-not-found, parse-error, malformed-input. The
 * specialization layer never introduces new error modes; recognition
 * is best-effort over the underlying-extractor result.
 *
 * @example
 *   const result = await extractCpqCustomMetadataRecord(
 *     'tests/fixtures/synthetic-v2.6a/customMetadata/SBQQ__PriceRule__c.HighDiscountAlert.md-meta.xml',
 *   );
 *   if (result.ok) {
 *     const cpqNode = result.value.nodes.find((n) => n.type === 'CpqPriceRule');
 *     console.log(cpqNode?.id);
 *     // => 'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert'
 *   }
 */
export const extractCpqCustomMetadataRecord = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const underlying = await extractCustomMetadataRecord(path);
  if (!underlying.ok) return underlying;
  return ok(specializeCpq(underlying.value));
};

/**
 * Extract a CPQ-specialized result from a Custom Setting record file
 * (`.dataset-meta.xml`). Calls the underlying v1.6 R2 extractor and
 * then applies the v2.6a specialization layer. Behavior is identical
 * to `extractCpqCustomMetadataRecord` except for the underlying
 * extractor; the recognition layer treats both record shapes
 * uniformly.
 *
 * @example
 *   const result = await extractCpqCustomSettingRecord(
 *     'tests/fixtures/customSettings/SBQQ__PriceRule__c/HighDiscountAlert.dataset-meta.xml',
 *   );
 */
export const extractCpqCustomSettingRecord = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const underlying = await extractCustomSettingRecord(path);
  if (!underlying.ok) return underlying;
  return ok(specializeCpq(underlying.value));
};
