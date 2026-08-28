/**
 * @sf-intelligence/graph
 *
 * The graph layer for `org-kb/`. v0.1 ships the DuckDB schema, the open/close
 * lifecycle, and migration plumbing; Phase D's remaining graph-* tasks add
 * the import pipeline that ingests the Markdown corpus into nodes/edges and
 * the query API consumed by the MCP tools. This barrel is the single public
 * surface.
 */

export {
  canonicalizeActivityPolymorphicFieldEdgeTargets,
  canonicalizeApexCallEdgeTargets,
  canonicalizeFieldEdgeTargets,
  canonicalizeLabelEdgeTargets,
  canonicalizeObjectEdgeTargets,
  canonicalizeResourceEdgeTargets,
  IMPORT_BATCH_SIZE,
  importExtractionResults,
  mintPolymorphicActivityFieldEdges,
} from './import.js';
export type { ImportCounts } from './import.js';
export {
  chooseSourcePath,
  isDxCanonicalPath,
  resolveDuplicateSourcePaths,
  SOURCE_CONFLICT_PROPERTY,
} from './duplicate-source.js';
export type {
  DuplicateSourceResolution,
  DuplicateSourceSummary,
  SourceConflictDisclosure,
  SourcePrecedence,
} from './duplicate-source.js';
export { relativizeSourcePath } from './relativize.js';
export {
  buildRelationshipMaps,
  mintRelationshipTraversalEdges,
  RELATIONSHIP_RESOLVER_SOURCE,
} from './relationship-refs.js';
export {
  applyChangeSet,
  changeSetSize,
  computeChangeSet,
  INCREMENTAL_DELTA_CAP,
  pruneStaleNodes,
} from './apply-change-set.js';
export type { ApplyCounts, ChangeSet, EdgeKey, PruneCounts } from './apply-change-set.js';
export {
  CURRENT_SCHEMA_VERSION,
  needsMigration,
  readSchemaVersion,
  runMigrations,
} from './migrations.js';
export type { Migration } from './migrations.js';
export {
  contributorsSummary,
  countNodesByType,
  danglingTargetIdsMatching,
  danglingTargetSummary,
  freshnessSummary,
  getNodeById,
  getSubgraph,
  IDENTITY_SCAN_MAX,
  isHiddenUnresolved,
  listChildren,
  listEdges,
  listEdgesForNodes,
  listNodeIdentities,
  listNodesByIds,
  listNodesByType,
  searchNodes,
  searchNodesPage,
} from './queries.js';
export type {
  Contributor,
  ContributorsSummary,
  CountNodesOptions,
  DanglingTargetGroup,
  FreshnessEntry,
  FreshnessSummary,
  ListEdgesForNodesOptions,
  ListEdgesOptions,
  ListNodesOptions,
  NodeIdentity,
  SearchHit,
  SearchNodesOptions,
  SearchNodesPage,
  Subgraph,
} from './queries.js';
export {
  compileGraphQuery,
  runGraphQuery,
  QUERY_GRAPH_ALLOWED_OPS,
  QUERY_GRAPH_DEFAULT_LIMIT,
  QUERY_GRAPH_DEFAULT_TIMEOUT_MS,
  QUERY_GRAPH_MAX_CONDITIONS,
  QUERY_GRAPH_MAX_IN_VALUES,
  QUERY_GRAPH_MAX_LIMIT,
} from './query-graph.js';
export type {
  CompiledGraphQuery,
  GraphQuery,
  GraphQueryCompileError,
  GraphQueryCondition,
  GraphQueryError,
  GraphQueryOp,
  GraphQueryResult,
  GraphQueryScalar,
  GraphQuerySelect,
  RunGraphQueryOptions,
} from './query-graph.js';
export {
  changeEventParentApiName,
  classifyPhantom,
  isChangeEventApiName,
  isChangeEventEntityId,
  managedNamespaceOf,
  type CoverageStatus,
} from './phantom-classify.js';
export {
  computePhantomBucketSummary,
  type PhantomBucketSummary,
  type PhantomCoverageLookup,
} from './phantom-bucket-summary.js';
export { fleetResolve } from './fleet.js';
export {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  writeFacts,
  readFacts,
  copyFacts,
  replaceFactsForMetricSource,
  clearFacts,
  isFactFresh,
  type Fact,
  type ReadFactsOptions,
} from './facts.js';
export type {
  FleetTopCandidate,
  FleetVaultRef,
  FleetVaultResult,
} from './fleet.js';
export {
  buildResolveIndex,
  gatherCandidates,
  getResolveIndex,
  persistResolveIndexArtifact,
  resolveIndexPathForGraph,
  tryLoadResolveIndexArtifact,
  writeResolveIndexArtifact,
} from './resolve-index.js';
export type {
  GetResolveIndexOptions,
  IndexedNode,
  PersistedResolveIndex,
  ResolveIndex,
} from './resolve-index.js';
export { resolveComponents } from './resolve.js';
export type {
  MatchKind,
  ResolveCandidate,
  ResolveDisposition,
  ResolveOptions,
  ResolveResult,
} from './resolve.js';
export { initSchema, SCHEMA_DDL } from './schema.js';
export { openGraphServeReadOnly } from './serve-readonly.js';
export {
  closeGraph,
  isLockConflict,
  isNativeBindingFailure,
  lockConflictMessage,
  nativeBindingMessage,
  openGraph,
  openGraphReadOnly,
  probeDuckDBNative,
} from './store.js';
export type { GraphError, GraphStore } from './store.js';
export {
  expandSynonyms,
  jaroWinkler,
  STOP_WORDS,
  tokenizeIdentifier,
  tokenizeText,
} from './tokenize.js';
