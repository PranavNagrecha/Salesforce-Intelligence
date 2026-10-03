/**
 * The OmniStudio model's parsing core: OmniScript / Integration Procedure
 * element trees, DataMapper items, data-key paths, merge expressions, show
 * rules and conditional formulas. Pure functions over the retrieved XML — no
 * graph access — shared by the extractors and the MCP analysis engine.
 */
export {
  type DataMapperDoc,
  type DataMapperHeader,
  type DataMapperItem,
  type DataMapperKind,
  type DataMapperParse,
  buildDataMapperDoc,
  extractAliases,
  isJsonOutputObject,
  parseDataMapper,
  parseDataMapperDataPack,
} from './data-mapper.js';
export { evaluateFormula, type FormulaResult, type FormulaValue } from './formula.js';
export {
  hasEdgeWhitespace,
  isPrefixOf,
  isSuffixOf,
  type KeyPath,
  type KeySegment,
  matchForm,
  type NearMiss,
  type NearMissOptions,
  type NearMissRule,
  nearMisses,
  nearMissRule,
  parseKeyPath,
  pathHasEdgeWhitespace,
  segmentNames,
} from './keys.js';
export {
  keySites,
  type MalformedMerge,
  type MergeRef,
  scanBraceRefs,
  scanPercentRefs,
  soleMergeRef,
  type StringSite,
  stringSites,
} from './merge.js';
export {
  buildOmniProcessDoc,
  descendantsOf,
  type OmniProcessDoc,
  type OmniProcessHeader,
  type OmniProcessKind,
  type OmniProcessParse,
  type OmniTreeElement,
  parseOmniProcess,
  parseOmniProcessDataPack,
} from './process.js';
export {
  compareCondition,
  evaluateShowRule,
  type FieldValue,
  parseShowRule,
  ruleConditions,
  type ShowRule,
  type Tri,
  triAnd,
  triNot,
  triOr,
} from './rules.js';
export {
  CHOICE_TYPES,
  editBlockActionKind,
  type ElementRole,
  elementRole,
  type IpStepRole,
  ipStepRole,
  isRepeating,
} from './taxonomy.js';
export {
  type ApexRemoteCall,
  type ApexRemoteTarget,
  apexRemoteTarget,
  buildApexRemoteEdges,
  literalObjectArgs,
  type RuntimeServiceCall,
  runtimeServiceCall,
} from './remote.js';
export {
  DATAPACK_FILE_SUFFIX,
  DATAPACK_KINDS,
  type DataPackComponentType,
  dataPackComponentType,
  type DataPackConversion,
  type DataPackKind,
  dataPackKindOfDir,
  dataPackNodeProperties,
  type DataPackRead,
  dataPackToCard,
  dataPackToMapper,
  dataPackToProcess,
  isDataPackPath,
  MANAGED_OMNISTUDIO_NAMESPACES,
  readDataPack,
  recordNamespace,
  stripNamespace,
  VLOCITY_NAMESPACE_PLACEHOLDER,
} from './datapack.js';
export {
  type CatalogElementRole,
  type CatalogIpStepRole,
  canonicalElementType,
  OMNI_ELEMENT_CATALOG,
  type OmniEffect,
  type OmniElementTypeInfo,
  omniElementInfo,
  type OmniRuntime,
} from './catalog.js';
export { readStaticSoql, type SoqlRead } from './soql.js';
