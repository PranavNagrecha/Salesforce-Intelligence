/**
 * Barrel for the knowledge (concept-model) plane. Import the concept model
 * from here (or from `./loader.js`) rather than reaching into `./generated/`.
 */
export {
  MODEL_VERSION,
  STATUS_CODE_TAXONOMY,
  type StatusCodeTaxonomy,
  type StatusCodeTaxonomyEntry,
  EDGE_SEMANTICS,
  type EdgeSemantics,
  type EdgeSemanticRule,
  type EdgeSemanticVerdict,
  // RM-2 — reasoning seed concepts + rules.
  CONCEPTS,
  CONCEPT_RULES,
} from './loader.js';

/**
 * RM-1a reasoning engine — the pure, deterministic `interpret`/`weakest` over a
 * caller-assembled grounded slice. The `Concept` / `ConceptRule` /
 * `Interpretation` contract types live in `@sf-intelligence/contracts`.
 */
export {
  aggregateHasUnresolvedCountedEndpoint,
  chainInterpret,
  compoundInterpret,
  interpret,
  reconcile,
  weakest,
  type Coverage,
  type GroundedSlice,
} from './reason.js';

/** EPIC-1 — second-pass chained rules (concept-output → concept-input). */
export { CHAINED_RULES } from './chained-rules.js';

/** EPIC-2 — cross-concept same-anchor composition rules. */
export { COMPOUND_RULES } from './compound-rules.js';

/** EPIC-3 — curated conflict-resolution (supersedes) edges. */
export { SUPERSEDES_RULES } from './supersedes-rules.js';

/**
 * The pure, cycle-safe transitive closure over the platform's
 * `PermissionDependency` graph — "granting X really confers X plus
 * everything X requires". No I/O; the graph is handed in.
 */
export {
  buildPermissionDependencyGraph,
  classifyPermissionKind,
  expandPermissionClosure,
  isObjectPermissionToken,
  OBJECT_PERMISSION_TYPE,
  parseObjectPermissionToken,
  USER_PERMISSION_TYPE,
  type ImpliedPermission,
  type PermissionClosureResult,
  type PermissionDependencyEdgeInput,
  type PermissionDependencyGraph,
  type PermissionKind,
} from './permission-closure.js';

/**
 * RM-loop PASS 2 — pure save-order phase derivation used by the join engine to
 * upgrade a coupled-field-write coupling to a strict cross-phase computed gate
 * when (and only when) it is provable.
 */
export {
  isSynchronousSavePhase,
  phaseOfAutomation,
  phaseOrdinal,
  type SaveOrderPhase,
} from './save-order-phase.js';
