/**
 * Thin, no-I/O typed accessor for the concept model (RM-0 status-code taxonomy
 * + RM-1b safe-to-delete-field edge semantics).
 *
 * The concept-model DATA lives in `packages/mcp/model/` (curator-owned YAML)
 * and is compiled into `./generated/concept-model.ts` (frozen literals) by
 * `scripts/build-concept-model.mjs`. This loader is the stable import surface
 * the rest of the server uses: it re-exports the generated, already-frozen
 * singletons. There is NO runtime file read, NO parsing, and NO `js-yaml` on the
 * shipped path — the values are module-level frozen constants, evaluated (and so
 * effectively memoized) exactly once.
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
  // RM-2 — reasoning seed concepts + rules (the org-agnostic reasoning model
  // the `interpret` engine reasons WITH; the `Concept` / `ConceptRule` contract
  // types live in `@sf-intelligence/contracts`).
  CONCEPTS,
  CONCEPT_RULES,
} from './generated/concept-model.js';
