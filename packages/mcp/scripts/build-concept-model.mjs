#!/usr/bin/env node
/**
 * RM-0 — Concept-model codegen (DATA track → CODE track).
 *
 * Reads the curator-owned YAML truth under `packages/mcp/model/`, does
 * lightweight STRUCTURAL validation in plain JS (required keys, types, and the
 * no-canonical-id invariant), then EMITS a deterministic, frozen TypeScript
 * artifact at `packages/mcp/src/knowledge/generated/concept-model.ts`.
 *
 *   DATA  (curator)   packages/mcp/model/status-taxonomy.yaml
 *                     packages/mcp/model/edge-semantics.yaml + MODEL_VERSION
 *      │  build-concept-model.mjs  (this file)
 *      ▼
 *   CODE  (engineer)  packages/mcp/src/knowledge/generated/concept-model.ts
 *
 * `js-yaml` is a BUILD-ONLY devDependency of packages/mcp. It is used here at
 * codegen time and is NEVER imported by shipped `src/`.
 *
 * Regenerate:  node packages/mcp/scripts/build-concept-model.mjs   (pnpm regen:concept-model)
 * Parity gate: node packages/mcp/scripts/check-concept-model.mjs   (pnpm check:concept-model)
 *
 * The generated output is deterministic: keys are emitted in the YAML's
 * document order (which is significant — see the YAML header).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Script lives at packages/mcp/scripts/ — mcpRoot is one level up.
const mcpRoot = path.resolve(scriptDir, '..');

export const MODEL_DIR = path.join(mcpRoot, 'model');
export const YAML_PATH = path.join(MODEL_DIR, 'status-taxonomy.yaml');
export const EDGE_SEMANTICS_PATH = path.join(MODEL_DIR, 'edge-semantics.yaml');
export const CONCEPTS_PATH = path.join(MODEL_DIR, 'concepts.yaml');
export const CONCEPT_RULES_PATH = path.join(MODEL_DIR, 'concept-rules.yaml');
export const VERSION_PATH = path.join(MODEL_DIR, 'MODEL_VERSION');
export const OUT_PATH = path.join(mcpRoot, 'src', 'knowledge', 'generated', 'concept-model.ts');

/** A string that starts with `Word:` looks like a canonical id (`Type:Name`). */
const CANONICAL_ID_RE = /^[A-Z][A-Za-z0-9]+:/;

/** The ConceptKind closed union (mirrors @sf-intelligence/contracts). */
const CONCEPT_KINDS = [
  'status-code',
  'save-order-phase',
  'field-provenance',
  'relationship',
  'automation-collision',
  'access-mechanism',
  'firing-condition',
  'async-boundary',
  'external-api-surface',
  'code-quality-defect',
  'test-quality',
];

/** The ConfidenceLevel closed union (mirrors @sf-intelligence/contracts). */
const CONFIDENCE_LEVELS = ['declared', 'parsed', 'heuristic'];

/** The RulePredicate `conditionKind` closed union. */
const CONDITION_KINDS = ['criteria', 'formula', 'flow-decision', 'flow-recordtrigger'];

/** The exact, ordered set of keys every taxonomy entry must carry. */
const ENTRY_KEYS = ['category', 'explanation', 'producedByTypes', 'crossRefObjectAutomation'];

class ModelError extends Error {}

/** Fail closed if a curated string value looks like a canonical id. */
function assertNoCanonicalId(value, where) {
  if (typeof value === 'string' && CANONICAL_ID_RE.test(value)) {
    throw new ModelError(
      `${where}: value looks like a canonical id (matches ${CANONICAL_ID_RE}): ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Parse + structurally validate the curated model. Returns
 * `{ modelVersion, statusCodes }` with `statusCodes` an ordered plain object.
 * Throws `ModelError` on any structural or invariant violation.
 */
export function loadConceptModel() {
  const modelVersion = readFileSync(VERSION_PATH, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(modelVersion)) {
    throw new ModelError(`MODEL_VERSION is not semver: ${JSON.stringify(modelVersion)}`);
  }

  const doc = yaml.load(readFileSync(YAML_PATH, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ModelError('status-taxonomy.yaml must be a mapping at the top level');
  }
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== 'statusCodes') {
    throw new ModelError(
      `status-taxonomy.yaml must have exactly one top-level key "statusCodes"; found: ${topKeys.join(', ')}`,
    );
  }
  const statusCodes = doc.statusCodes;
  if (statusCodes === null || typeof statusCodes !== 'object' || Array.isArray(statusCodes)) {
    throw new ModelError('statusCodes must be a mapping');
  }
  const codes = Object.keys(statusCodes);
  if (codes.length === 0) {
    throw new ModelError('statusCodes is empty');
  }

  for (const code of codes) {
    assertNoCanonicalId(code, `statusCodes.${code} (key)`);
    const entry = statusCodes[code];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ModelError(`statusCodes.${code} must be a mapping`);
    }
    const entryKeys = Object.keys(entry);
    const missing = ENTRY_KEYS.filter((k) => !entryKeys.includes(k));
    if (missing.length > 0) {
      throw new ModelError(`statusCodes.${code}: missing required key(s): ${missing.join(', ')}`);
    }
    const unknown = entryKeys.filter((k) => !ENTRY_KEYS.includes(k));
    if (unknown.length > 0) {
      throw new ModelError(`statusCodes.${code}: unknown key(s): ${unknown.join(', ')}`);
    }

    if (typeof entry.category !== 'string' || entry.category.length === 0) {
      throw new ModelError(`statusCodes.${code}.category must be a non-empty string`);
    }
    assertNoCanonicalId(entry.category, `statusCodes.${code}.category`);

    if (typeof entry.explanation !== 'string' || entry.explanation.length === 0) {
      throw new ModelError(`statusCodes.${code}.explanation must be a non-empty string`);
    }
    assertNoCanonicalId(entry.explanation, `statusCodes.${code}.explanation`);

    if (!Array.isArray(entry.producedByTypes)) {
      throw new ModelError(`statusCodes.${code}.producedByTypes must be an array`);
    }
    entry.producedByTypes.forEach((t, i) => {
      if (typeof t !== 'string' || t.length === 0) {
        throw new ModelError(`statusCodes.${code}.producedByTypes[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(t, `statusCodes.${code}.producedByTypes[${i}]`);
    });

    if (typeof entry.crossRefObjectAutomation !== 'boolean') {
      throw new ModelError(`statusCodes.${code}.crossRefObjectAutomation must be a boolean`);
    }
  }

  return { modelVersion, statusCodes };
}

/** The exact, ordered set of keys a {category, verdict} classification carries. */
const VERDICT_KEYS = ['category', 'verdict'];

/**
 * Validate one `{category, verdict}` classification pair: both keys present,
 * no extras, each a non-empty string, neither a canonical id. Throws
 * `ModelError` on any violation. `where` is the dotted path for the message.
 */
function assertVerdictPair(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(value);
  const missing = VERDICT_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  const unknown = keys.filter((k) => !VERDICT_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  for (const k of VERDICT_KEYS) {
    if (typeof value[k] !== 'string' || value[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(value[k], `${where}.${k}`);
  }
}

/** The exact, ordered set of keys the `edgeSemantics` root carries. */
const EDGE_SEMANTICS_KEYS = ['bySource', 'byEdgeType', 'default'];
/** Required keys on each ordered `bySource` special-case entry. */
const BY_SOURCE_REQUIRED_KEYS = ['source', 'edgeType', 'category', 'verdict'];
/** Optional keys on a `bySource` entry (`fromType` scopes it to one referrer type). */
const BY_SOURCE_OPTIONAL_KEYS = ['fromType'];
/** The keys each per-edge-type rule carries. */
const EDGE_RULE_KEYS = ['bySourceType', 'default'];

/**
 * Parse + structurally validate the curated edge-semantics model. Returns the
 * ordered `edgeSemantics` plain object (mirrors `classifyEdge`'s per-edge
 * lookup). Throws `ModelError` on any structural or no-canonical-id violation.
 */
export function loadEdgeSemantics() {
  const doc = yaml.load(readFileSync(EDGE_SEMANTICS_PATH, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ModelError('edge-semantics.yaml must be a mapping at the top level');
  }
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== 'edgeSemantics') {
    throw new ModelError(
      `edge-semantics.yaml must have exactly one top-level key "edgeSemantics"; found: ${topKeys.join(', ')}`,
    );
  }
  const es = doc.edgeSemantics;
  if (es === null || typeof es !== 'object' || Array.isArray(es)) {
    throw new ModelError('edgeSemantics must be a mapping');
  }
  const esKeys = Object.keys(es);
  const esMissing = EDGE_SEMANTICS_KEYS.filter((k) => !esKeys.includes(k));
  if (esMissing.length > 0) {
    throw new ModelError(`edgeSemantics: missing required key(s): ${esMissing.join(', ')}`);
  }
  const esUnknown = esKeys.filter((k) => !EDGE_SEMANTICS_KEYS.includes(k));
  if (esUnknown.length > 0) {
    throw new ModelError(`edgeSemantics: unknown key(s): ${esUnknown.join(', ')}`);
  }

  // bySource — ORDERED special cases, checked first by classifyEdge. A list
  // (not a map) because evaluation order is part of the contract: the first
  // matching entry wins, and `formula-tokenizer` must beat the per-source-type
  // rows it overlaps.
  const bySource = es.bySource;
  if (!Array.isArray(bySource) || bySource.length === 0) {
    throw new ModelError('edgeSemantics.bySource must be a non-empty list');
  }
  const seenSourceScopes = new Set();
  for (const [i, entry] of bySource.entries()) {
    const at = `edgeSemantics.bySource[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ModelError(`${at} must be a mapping`);
    }
    const keys = Object.keys(entry);
    const missing = BY_SOURCE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
    if (missing.length > 0) {
      throw new ModelError(`${at}: missing required key(s): ${missing.join(', ')}`);
    }
    const allowed = [...BY_SOURCE_REQUIRED_KEYS, ...BY_SOURCE_OPTIONAL_KEYS];
    const unknown = keys.filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      throw new ModelError(`${at}: unknown key(s): ${unknown.join(', ')}`);
    }
    for (const k of keys) {
      if (typeof entry[k] !== 'string' || entry[k].length === 0) {
        throw new ModelError(`${at}.${k} must be a non-empty string`);
      }
      assertNoCanonicalId(entry[k], `${at}.${k}`);
    }
    // A duplicate (source, edgeType, fromType) scope would make an entry
    // unreachable — a silent curation error, so fail loudly instead.
    const scope = `${entry.source}\u0000${entry.edgeType}\u0000${entry.fromType ?? '*'}`;
    if (seenSourceScopes.has(scope)) {
      throw new ModelError(`${at}: duplicate (source, edgeType, fromType) scope — the later entry is unreachable`);
    }
    seenSourceScopes.add(scope);
  }

  // byEdgeType — edgeType -> { bySourceType, default }.
  const byEdgeType = es.byEdgeType;
  if (byEdgeType === null || typeof byEdgeType !== 'object' || Array.isArray(byEdgeType)) {
    throw new ModelError('edgeSemantics.byEdgeType must be a mapping');
  }
  const edgeTypes = Object.keys(byEdgeType);
  if (edgeTypes.length === 0) {
    throw new ModelError('edgeSemantics.byEdgeType is empty');
  }
  for (const edgeType of edgeTypes) {
    assertNoCanonicalId(edgeType, `edgeSemantics.byEdgeType.${edgeType} (key)`);
    const rule = byEdgeType[edgeType];
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new ModelError(`edgeSemantics.byEdgeType.${edgeType} must be a mapping`);
    }
    const ruleKeys = Object.keys(rule);
    const ruleMissing = EDGE_RULE_KEYS.filter((k) => !ruleKeys.includes(k));
    if (ruleMissing.length > 0) {
      throw new ModelError(
        `edgeSemantics.byEdgeType.${edgeType}: missing required key(s): ${ruleMissing.join(', ')}`,
      );
    }
    const ruleUnknown = ruleKeys.filter((k) => !EDGE_RULE_KEYS.includes(k));
    if (ruleUnknown.length > 0) {
      throw new ModelError(
        `edgeSemantics.byEdgeType.${edgeType}: unknown key(s): ${ruleUnknown.join(', ')}`,
      );
    }
    const bySourceType = rule.bySourceType;
    if (bySourceType === null || typeof bySourceType !== 'object' || Array.isArray(bySourceType)) {
      throw new ModelError(`edgeSemantics.byEdgeType.${edgeType}.bySourceType must be a mapping`);
    }
    for (const sourceType of Object.keys(bySourceType)) {
      assertNoCanonicalId(
        sourceType,
        `edgeSemantics.byEdgeType.${edgeType}.bySourceType.${sourceType} (key)`,
      );
      assertVerdictPair(
        bySourceType[sourceType],
        `edgeSemantics.byEdgeType.${edgeType}.bySourceType.${sourceType}`,
      );
    }
    assertVerdictPair(rule.default, `edgeSemantics.byEdgeType.${edgeType}.default`);
  }

  // top-level fallback for an unknown edge type.
  assertVerdictPair(es.default, 'edgeSemantics.default');

  return es;
}

// ── RM-2: concepts + concept-rules (DATA track) ──────────────────────────────

/** The keys a concept entry must carry (docs is optional). */
const CONCEPT_REQUIRED_KEYS = ['kind', 'label', 'summary'];
const CONCEPT_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CONCEPT_ALLOWED_KEYS = [...CONCEPT_REQUIRED_KEYS, 'severity', 'docs'];
/** The keys a DocLink carries. */
const DOC_LINK_KEYS = ['label', 'url'];

/**
 * Parse + structurally validate the curated RM-2 concept dictionary. Returns an
 * ORDERED plain object (ConceptId → concept entry) preserving YAML document
 * order. Throws `ModelError` on any structural or no-canonical-id violation.
 */
export function loadConcepts() {
  const doc = yaml.load(readFileSync(CONCEPTS_PATH, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ModelError('concepts.yaml must be a mapping at the top level');
  }
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== 'concepts') {
    throw new ModelError(
      `concepts.yaml must have exactly one top-level key "concepts"; found: ${topKeys.join(', ')}`,
    );
  }
  const concepts = doc.concepts;
  if (concepts === null || typeof concepts !== 'object' || Array.isArray(concepts)) {
    throw new ModelError('concepts must be a mapping');
  }
  const ids = Object.keys(concepts);
  if (ids.length === 0) {
    throw new ModelError('concepts is empty');
  }

  for (const id of ids) {
    assertNoCanonicalId(id, `concepts.${id} (key)`);
    const entry = concepts[id];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ModelError(`concepts.${id} must be a mapping`);
    }
    const keys = Object.keys(entry);
    const missing = CONCEPT_REQUIRED_KEYS.filter((k) => !keys.includes(k));
    if (missing.length > 0) {
      throw new ModelError(`concepts.${id}: missing required key(s): ${missing.join(', ')}`);
    }
    const unknown = keys.filter((k) => !CONCEPT_ALLOWED_KEYS.includes(k));
    if (unknown.length > 0) {
      throw new ModelError(`concepts.${id}: unknown key(s): ${unknown.join(', ')}`);
    }

    if (!CONCEPT_KINDS.includes(entry.kind)) {
      throw new ModelError(
        `concepts.${id}.kind must be one of ${CONCEPT_KINDS.join(' | ')}; got ${JSON.stringify(entry.kind)}`,
      );
    }
    for (const k of ['label', 'summary']) {
      if (typeof entry[k] !== 'string' || entry[k].length === 0) {
        throw new ModelError(`concepts.${id}.${k} must be a non-empty string`);
      }
      assertNoCanonicalId(entry[k], `concepts.${id}.${k}`);
    }

    if (entry.severity !== undefined) {
      if (!CONCEPT_SEVERITIES.includes(entry.severity)) {
        throw new ModelError(
          `concepts.${id}.severity must be one of ${CONCEPT_SEVERITIES.join(' | ')}; got ${JSON.stringify(entry.severity)}`,
        );
      }
    }

    if (entry.docs !== undefined) {
      if (!Array.isArray(entry.docs)) {
        throw new ModelError(`concepts.${id}.docs must be an array`);
      }
      entry.docs.forEach((d, i) => {
        if (d === null || typeof d !== 'object' || Array.isArray(d)) {
          throw new ModelError(`concepts.${id}.docs[${i}] must be a mapping`);
        }
        const dKeys = Object.keys(d);
        const dMissing = DOC_LINK_KEYS.filter((k) => !dKeys.includes(k));
        if (dMissing.length > 0) {
          throw new ModelError(`concepts.${id}.docs[${i}]: missing required key(s): ${dMissing.join(', ')}`);
        }
        const dUnknown = dKeys.filter((k) => !DOC_LINK_KEYS.includes(k));
        if (dUnknown.length > 0) {
          throw new ModelError(`concepts.${id}.docs[${i}]: unknown key(s): ${dUnknown.join(', ')}`);
        }
        for (const k of DOC_LINK_KEYS) {
          if (typeof d[k] !== 'string' || d[k].length === 0) {
            throw new ModelError(`concepts.${id}.docs[${i}].${k} must be a non-empty string`);
          }
          assertNoCanonicalId(d[k], `concepts.${id}.docs[${i}].${k}`);
        }
      });
    }
  }

  return concepts;
}

/** The keys every concept-rule entry MUST carry (all required). */
const RULE_KEYS = [
  'id',
  'concept',
  'bind',
  'interpretation',
  'maxConfidence',
  'absenceShaped',
  'dependsOnCoverage',
];
/**
 * OPTIONAL concept-rule keys (present or absent). `interpretationCrossPhase` is
 * the RM-loop PASS 2 upgraded JOIN template the engine renders instead of
 * `interpretation` for a coupling it can PROVE is cross-phase.
 * `witnessPartition` (REASONING-ASYNC-TEST-CALLER-BLEED) classifies an edge
 * rule's matched edges into production vs test-witness so a test-only edge never
 * establishes production reachability.
 */
const RULE_OPTIONAL_KEYS = ['interpretationCrossPhase', 'witnessPartition', 'remediation'];
/**
 * The keys a `remediation` (CITED-REMEDIATION authored fix) may carry. `steps` is
 * required (a non-empty array of ordered, org-agnostic template strings);
 * `whatIfTool` is an optional pointer to a real tool that can MODEL the
 * counterfactual (never a closure claim).
 */
const REMEDIATION_KEYS = ['steps', 'whatIfTool'];
/** The required subset of {@link REMEDIATION_KEYS}. */
const REMEDIATION_REQUIRED_KEYS = ['steps'];
/**
 * The keys a `witnessPartition` (edge-rule primary-vs-witness plane guard) may
 * carry. `witnessKind` + `witnessProperty` are OPTIONAL: `witnessKind` defaults
 * to `property` (the async guard), and `witnessProperty` is required ONLY in
 * `property` mode (unused in `inactive-firer` mode). The two templates + the role
 * endpoint are always required.
 */
const WITNESS_PARTITION_KEYS = [
  'roleEndpoint',
  'witnessKind',
  'witnessProperty',
  'witnessArrayProperty',
  'witnessArrayMember',
  'interpretationWitnessOnly',
  'interpretationMixedWitnessSuffix',
];
/** The `witnessPartition` keys that are ALWAYS required (regardless of mode). */
const WITNESS_PARTITION_REQUIRED_KEYS = [
  'roleEndpoint',
  'interpretationWitnessOnly',
  'interpretationMixedWitnessSuffix',
];
/** The endpoint roles a `witnessPartition.roleEndpoint` may carry. */
const WITNESS_ROLE_ENDPOINTS = ['from', 'to'];
/** The classification modes a `witnessPartition.witnessKind` may carry. */
const WITNESS_KINDS = ['property', 'inactive-firer', 'system-perm-holder'];
/** The full set a rule entry MAY carry (required + optional). */
const RULE_ALLOWED_KEYS = [...RULE_KEYS, ...RULE_OPTIONAL_KEYS];
/** The keys a RulePredicate `bind` may carry (all optional; >=1 required). */
const BIND_KEYS = [
  'edgeType',
  'componentTypes',
  'conditionKind',
  'whereProperty',
  'edgeWhereProperty',
  'toWhereProperty',
  'fromWhereProperty',
  'toObjectIn',
  'toTypeIn',
  'fromTypeIn',
  'order',
  'join',
  'aggregate',
  'dualEdge',
  'antiJoin',
  'setDifference',
  'propertyCompare',
  'fieldJoin',
  'propertyEqualsEndpoint',
  'crossObjectCascade',
];
/** The keys a `whereProperty` / `edgeWhereProperty` predicate carries. */
const WHERE_KEYS = ['key', 'equals'];
/**
 * The comparison operators a `whereProperty` clause may carry (EXACTLY ONE per
 * clause, alongside `key`). `equals` is the original scalar-equals (unchanged);
 * `in` / `notIn` take a non-empty array of scalars; `neq` a single scalar;
 * `isNull` a boolean (a NULLISH present/absent test — see the engine's
 * `clauseHolds`). This is the operator-class extension — `edgeWhereProperty` and
 * the aggregate's endpoint/counted-edge filters stay equals-ONLY (validated by
 * {@link assertWhereMapping}), so only `whereProperty` gains operators.
 */
const WHERE_OPERATORS = ['equals', 'in', 'notIn', 'neq', 'isNull', 'isEmpty', 'anyElement'];
/** The subset of {@link WHERE_OPERATORS} whose operand is a NON-EMPTY scalar array. */
const WHERE_ARRAY_OPERATORS = ['in', 'notIn'];
/** The subset of {@link WHERE_OPERATORS} whose operand MUST be a boolean. */
const WHERE_BOOLEAN_OPERATORS = ['isNull', 'isEmpty'];
/**
 * The subset of {@link WHERE_OPERATORS} whose operand is an EXISTENTIAL
 * array-element matcher (CAP-A / CAP-B) — a nested {@link ArrayElementClause}
 * validated by {@link assertAnyElementClause}, NOT a scalar / array / boolean.
 */
const WHERE_ELEMENT_OPERATORS = ['anyElement'];
/**
 * The scalar comparison operators an `anyElement` INNER clause may carry (EXACTLY
 * ONE). A strict subset of {@link WHERE_OPERATORS}: NO `isNull` and NO nested
 * `anyElement` — the inner is a flat scalar comparison over one array's elements.
 */
const WHERE_INNER_OPERATORS = ['equals', 'in', 'notIn', 'neq'];
/** The keys a RulePredicate `join` (RM-loop multi-edge JOIN) may carry. */
const JOIN_KEYS = [
  'throughType',
  'throughConditionKinds',
  'throughKeyArray',
  'writeEdgeType',
  'writerTypes',
  'sameObject',
  'excludeSelf',
  'excludeInactiveFirer',
  'excludeTestWriter',
  'excludeInactiveWriter',
  'phaseFilter',
];
/** The required subset of {@link JOIN_KEYS} (the two arrays are optional). */
const JOIN_REQUIRED_KEYS = ['throughType', 'throughKeyArray', 'writeEdgeType', 'sameObject', 'excludeSelf'];
/** The keys a RulePredicate `aggregate` (RM-loop group-count) may carry. */
const AGGREGATE_KEYS = [
  'groupByEdgeProperty',
  'eventSplitByProperty',
  'edgeSource',
  'endpointWhereProperty',
  'countedEdgeWhereProperty',
  'countDistinctEndpoint',
  'op',
  'threshold',
  'firstMatchOrdinal',
];
/** The required subset of {@link AGGREGATE_KEYS} (grouping + endpoint filter are optional). */
const AGGREGATE_REQUIRED_KEYS = ['op', 'threshold'];
/** Keys a RuleFirstMatchOrdinal (`aggregate.firstMatchOrdinal`) may carry. */
const FIRST_MATCH_ORDINAL_KEYS = ['ordinalEdgeProperty', 'broadEntryWhere'];
/** Required subset of {@link FIRST_MATCH_ORDINAL_KEYS}. */
const FIRST_MATCH_ORDINAL_REQUIRED_KEYS = ['ordinalEdgeProperty', 'broadEntryWhere'];
/** The comparison ops a RuleAggregate `op` may carry (`gte` collision, `eq` exact cardinality). */
const AGGREGATE_OPS = ['gte', 'eq'];
/** The edge-source loci a RuleAggregate `edgeSource` may carry. */
const AGGREGATE_EDGE_SOURCES = ['root-incident', 'root-children-outgoing', 'root-outgoing'];
/** The counted-edge endpoints a RuleAggregate `countDistinctEndpoint` may carry. */
const AGGREGATE_DISTINCT_ENDPOINTS = ['from', 'to'];
/** The keys a RulePredicate `dualEdge` (EC-6 single-node dual-edge) may carry. */
const DUAL_EDGE_KEYS = ['edgeTypeA', 'edgeTypeB', 'sameObject', 'excludeInactive'];
/** The required subset of {@link DUAL_EDGE_KEYS}. */
const DUAL_EDGE_REQUIRED_KEYS = ['edgeTypeA', 'edgeTypeB', 'sameObject'];
/** The keys a RulePredicate `crossObjectCascade` (EC-11 D3) may carry. */
const CROSS_OBJECT_CASCADE_KEYS = [
  'writerTriggerEdge',
  'writeEdge',
  'targetIncomingEdgeTypes',
  'excludeInactive',
  'excludeBeforeSaveFlowWriter',
];
/** The required subset of {@link CROSS_OBJECT_CASCADE_KEYS}. */
const CROSS_OBJECT_CASCADE_REQUIRED_KEYS = [
  'writerTriggerEdge',
  'writeEdge',
  'targetIncomingEdgeTypes',
];
/** The keys a RulePredicate `antiJoin` (EC-8 present-A/absent-B) may carry. */
const ANTI_JOIN_KEYS = [
  'absentEdgeType',
  'absentFromTypes',
  'absentToTypes',
  'absentEdgeWhereProperty',
  'absentFromWhereProperty',
  'absentToWhereProperty',
  'correlate',
  'absentFromPhaseIn',
];
/** The required subset of {@link ANTI_JOIN_KEYS}. */
const ANTI_JOIN_REQUIRED_KEYS = ['absentEdgeType', 'correlate'];
/** Closed set of anti-join correlate modes. */
const ANTI_JOIN_CORRELATES = [
  'sameFrom',
  'sameTo',
  'sameFromToPresentObject',
  'sameFromToRoot',
];
/** Closed set of save-order phases an anti-join may filter the absent FROM by. */
const ANTI_JOIN_PHASES = [
  'before-save-flows',
  'pre-save-triggers',
  'pre-save-validation',
  'after-triggers',
  'post-save-assignment',
  'post-save-workflows',
  'post-save-flows',
  'post-save-approval',
];
/** The keys a RulePredicate `setDifference` (EC-9 INCLUDE − SUBTRACT) may carry. */
const SET_DIFFERENCE_KEYS = [
  'includeEdgeType',
  'includeEdgeWhereProperty',
  'includeToTypes',
  'subtractEdgeType',
  'subtractEdgeWhereProperty',
  'subtractToTypes',
  'requireBothNonEmpty',
];
/** The required subset of {@link SET_DIFFERENCE_KEYS}. */
const SET_DIFFERENCE_REQUIRED_KEYS = ['includeEdgeType', 'subtractEdgeType'];
/** The keys a RulePredicate `propertyCompare` (EC-12 property-vs-property) may carry. */
const PROPERTY_COMPARE_KEYS = ['leftKey', 'rightKey', 'op', 'rankTable'];
/** The required subset of {@link PROPERTY_COMPARE_KEYS}. */
const PROPERTY_COMPARE_REQUIRED_KEYS = ['leftKey', 'rightKey', 'op', 'rankTable'];
/** Closed set of propertyCompare ops. */
const PROPERTY_COMPARE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
/** Closed set of named ordinal rank tables (org-agnostic curated tables). */
const PROPERTY_COMPARE_RANK_TABLES = ['owdPermissiveness'];
/** The keys a RulePredicate `fieldJoin` (EC-10 intra-object field join) may carry. */
const FIELD_JOIN_KEYS = ['nameProperty', 'orphanSetDiff'];
/** The required subset of {@link FIELD_JOIN_KEYS}. */
const FIELD_JOIN_REQUIRED_KEYS = ['nameProperty'];
/** The keys a RuleFieldJoin `orphanSetDiff` may carry. */
const FIELD_JOIN_ORPHAN_KEYS = [
  'leftArrayKey',
  'leftElementKey',
  'rightArrayKey',
  'rightElementKey',
  'rightElementWhere',
];
/** The required subset of {@link FIELD_JOIN_ORPHAN_KEYS}. */
const FIELD_JOIN_ORPHAN_REQUIRED_KEYS = [
  'leftArrayKey',
  'leftElementKey',
  'rightArrayKey',
  'rightElementKey',
];
/** The keys a RulePredicate `propertyEqualsEndpoint` (D9 node-prop vs endpoint) may carry. */
const PROPERTY_EQUALS_ENDPOINT_KEYS = [
  'nodeProperty',
  'endpointEdgeType',
  'relation',
  'endpointEdgeWhereProperty',
  'excludeInactive',
];
/** The required subset of {@link PROPERTY_EQUALS_ENDPOINT_KEYS}. */
const PROPERTY_EQUALS_ENDPOINT_REQUIRED_KEYS = ['nodeProperty', 'endpointEdgeType', 'relation'];
/** Closed set of propertyEqualsEndpoint object-scope relations. */
const PROPERTY_EQUALS_ENDPOINT_RELATIONS = ['equal', 'notEqual'];

/**
 * Validate one `join` RuleJoin: only allowed keys, all required present, each
 * field well-typed, no canonical ids in any string value. Throws `ModelError`.
 */
function assertJoin(join, where) {
  if (join === null || typeof join !== 'object' || Array.isArray(join)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(join);
  const unknown = keys.filter((k) => !JOIN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = JOIN_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['throughType', 'throughKeyArray', 'writeEdgeType']) {
    if (typeof join[k] !== 'string' || join[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(join[k], `${where}.${k}`);
  }
  for (const k of ['sameObject', 'excludeSelf']) {
    if (typeof join[k] !== 'boolean') {
      throw new ModelError(`${where}.${k} must be a boolean`);
    }
  }
  // Dead-plane gates — optional booleans (omitted ⇒ no gate).
  for (const k of ['excludeInactiveFirer', 'excludeTestWriter', 'excludeInactiveWriter']) {
    if (join[k] !== undefined && typeof join[k] !== 'boolean') {
      throw new ModelError(`${where}.${k} must be a boolean`);
    }
  }
  if (join.phaseFilter !== undefined) {
    if (join.phaseFilter !== 'writer-earlier' && join.phaseFilter !== 'writer-later') {
      throw new ModelError(
        `${where}.phaseFilter must be 'writer-earlier' | 'writer-later'; got ${JSON.stringify(join.phaseFilter)}`,
      );
    }
  }
  if (join.throughConditionKinds !== undefined) {
    if (!Array.isArray(join.throughConditionKinds) || join.throughConditionKinds.length === 0) {
      throw new ModelError(`${where}.throughConditionKinds must be a non-empty array`);
    }
    join.throughConditionKinds.forEach((k, i) => {
      if (!CONDITION_KINDS.includes(k)) {
        throw new ModelError(
          `${where}.throughConditionKinds[${i}] must be one of ${CONDITION_KINDS.join(' | ')}; got ${JSON.stringify(k)}`,
        );
      }
    });
  }
  if (join.writerTypes !== undefined) {
    if (!Array.isArray(join.writerTypes) || join.writerTypes.length === 0) {
      throw new ModelError(`${where}.writerTypes must be a non-empty array`);
    }
    join.writerTypes.forEach((t, i) => {
      if (typeof t !== 'string' || t.length === 0) {
        throw new ModelError(`${where}.writerTypes[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(t, `${where}.writerTypes[${i}]`);
    });
  }
}

/**
 * Validate one `aggregate` RuleAggregate: only allowed keys, both required
 * present, `op` in the closed set, `threshold` a non-negative integer, and the
 * optional grouping / endpoint-filter well-typed with no canonical ids. Throws
 * `ModelError`.
 */
function assertFirstMatchOrdinal(fmo, where) {
  if (fmo === null || typeof fmo !== 'object' || Array.isArray(fmo)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(fmo);
  const unknown = keys.filter((k) => !FIRST_MATCH_ORDINAL_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = FIRST_MATCH_ORDINAL_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  if (typeof fmo.ordinalEdgeProperty !== 'string' || fmo.ordinalEdgeProperty.length === 0) {
    throw new ModelError(`${where}.ordinalEdgeProperty must be a non-empty string`);
  }
  assertNoCanonicalId(fmo.ordinalEdgeProperty, `${where}.ordinalEdgeProperty`);
  if (Array.isArray(fmo.broadEntryWhere)) {
    if (fmo.broadEntryWhere.length === 0) {
      throw new ModelError(`${where}.broadEntryWhere must be a non-empty array`);
    }
    fmo.broadEntryWhere.forEach((el, i) => {
      assertWhereClause(el, `${where}.broadEntryWhere[${i}]`);
    });
  } else {
    assertWhereClause(fmo.broadEntryWhere, `${where}.broadEntryWhere`);
  }
}

function assertAggregate(agg, where) {
  if (agg === null || typeof agg !== 'object' || Array.isArray(agg)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(agg);
  const unknown = keys.filter((k) => !AGGREGATE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const countPath = agg.firstMatchOrdinal === undefined;
  const missing = (countPath ? AGGREGATE_REQUIRED_KEYS : []).filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  if (countPath && !AGGREGATE_OPS.includes(agg.op)) {
    throw new ModelError(
      `${where}.op must be one of ${AGGREGATE_OPS.join(' | ')}; got ${JSON.stringify(agg.op)}`,
    );
  }
  if (
    countPath &&
    (typeof agg.threshold !== 'number' || !Number.isInteger(agg.threshold) || agg.threshold < 0)
  ) {
    throw new ModelError(`${where}.threshold must be a non-negative integer`);
  }
  if (agg.groupByEdgeProperty !== undefined) {
    if (typeof agg.groupByEdgeProperty !== 'string' || agg.groupByEdgeProperty.length === 0) {
      throw new ModelError(`${where}.groupByEdgeProperty must be a non-empty string`);
    }
    assertNoCanonicalId(agg.groupByEdgeProperty, `${where}.groupByEdgeProperty`);
  }
  if (agg.eventSplitByProperty !== undefined) {
    if (typeof agg.eventSplitByProperty !== 'string' || agg.eventSplitByProperty.length === 0) {
      throw new ModelError(`${where}.eventSplitByProperty must be a non-empty string`);
    }
    assertNoCanonicalId(agg.eventSplitByProperty, `${where}.eventSplitByProperty`);
    // Event-split refines a TIMING bucket into its DML-event sub-buckets, so it is
    // only meaningful alongside `groupByEdgeProperty` (the timing grouping).
    if (agg.groupByEdgeProperty === undefined) {
      throw new ModelError(`${where}.eventSplitByProperty requires ${where}.groupByEdgeProperty`);
    }
  }
  if (agg.endpointWhereProperty !== undefined) {
    assertWhereClause(agg.endpointWhereProperty, `${where}.endpointWhereProperty`);
  }
  if (agg.countedEdgeWhereProperty !== undefined) {
    assertWhereClause(agg.countedEdgeWhereProperty, `${where}.countedEdgeWhereProperty`);
  }
  if (agg.edgeSource !== undefined && !AGGREGATE_EDGE_SOURCES.includes(agg.edgeSource)) {
    throw new ModelError(
      `${where}.edgeSource must be one of ${AGGREGATE_EDGE_SOURCES.join(' | ')}; got ${JSON.stringify(agg.edgeSource)}`,
    );
  }
  if (
    agg.countDistinctEndpoint !== undefined &&
    !AGGREGATE_DISTINCT_ENDPOINTS.includes(agg.countDistinctEndpoint)
  ) {
    throw new ModelError(
      `${where}.countDistinctEndpoint must be one of ${AGGREGATE_DISTINCT_ENDPOINTS.join(' | ')}; got ${JSON.stringify(agg.countDistinctEndpoint)}`,
    );
  }
  if (agg.firstMatchOrdinal !== undefined) {
    assertFirstMatchOrdinal(agg.firstMatchOrdinal, `${where}.firstMatchOrdinal`);
    if (agg.groupByEdgeProperty !== undefined || agg.eventSplitByProperty !== undefined) {
      throw new ModelError(
        `${where}.firstMatchOrdinal is mutually exclusive with groupByEdgeProperty and eventSplitByProperty`,
      );
    }
  }
}

/**
 * Validate one `dualEdge` RuleDualEdge (EC-6): only allowed keys, required
 * present, edge types non-empty strings, `sameObject` boolean, optional
 * `excludeInactive` boolean. Throws `ModelError`.
 */
function assertDualEdge(dual, where) {
  if (dual === null || typeof dual !== 'object' || Array.isArray(dual)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(dual);
  const unknown = keys.filter((k) => !DUAL_EDGE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = DUAL_EDGE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['edgeTypeA', 'edgeTypeB']) {
    if (typeof dual[k] !== 'string' || dual[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(dual[k], `${where}.${k}`);
  }
  if (typeof dual.sameObject !== 'boolean') {
    throw new ModelError(`${where}.sameObject must be a boolean`);
  }
  if (dual.excludeInactive !== undefined && typeof dual.excludeInactive !== 'boolean') {
    throw new ModelError(`${where}.excludeInactive must be a boolean`);
  }
}

/**
 * Validate one `crossObjectCascade` RuleCrossObjectCascade (EC-11 / D3): only
 * allowed keys, required present, edge types non-empty strings (no canonical
 * ids), `targetIncomingEdgeTypes` a non-empty string array, and optional
 * `excludeInactive` / `excludeBeforeSaveFlowWriter` booleans. Throws
 * `ModelError`.
 */
function assertCrossObjectCascade(cc, where) {
  if (cc === null || typeof cc !== 'object' || Array.isArray(cc)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(cc);
  const unknown = keys.filter((k) => !CROSS_OBJECT_CASCADE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = CROSS_OBJECT_CASCADE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['writerTriggerEdge', 'writeEdge']) {
    if (typeof cc[k] !== 'string' || cc[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(cc[k], `${where}.${k}`);
  }
  if (!Array.isArray(cc.targetIncomingEdgeTypes) || cc.targetIncomingEdgeTypes.length === 0) {
    throw new ModelError(`${where}.targetIncomingEdgeTypes must be a non-empty array`);
  }
  cc.targetIncomingEdgeTypes.forEach((t, i) => {
    if (typeof t !== 'string' || t.length === 0) {
      throw new ModelError(`${where}.targetIncomingEdgeTypes[${i}] must be a non-empty string`);
    }
    assertNoCanonicalId(t, `${where}.targetIncomingEdgeTypes[${i}]`);
  });
  for (const k of ['excludeInactive', 'excludeBeforeSaveFlowWriter']) {
    if (cc[k] !== undefined && typeof cc[k] !== 'boolean') {
      throw new ModelError(`${where}.${k} must be a boolean`);
    }
  }
}

/**
 * Validate one `antiJoin` RuleAntiJoin (EC-8): only allowed keys, required
 * present, correlate in the closed set, optional type arrays / where filters /
 * phase filter well-typed. Throws `ModelError`.
 */
function assertAntiJoin(anti, where) {
  if (anti === null || typeof anti !== 'object' || Array.isArray(anti)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(anti);
  const unknown = keys.filter((k) => !ANTI_JOIN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = ANTI_JOIN_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  if (typeof anti.absentEdgeType !== 'string' || anti.absentEdgeType.length === 0) {
    throw new ModelError(`${where}.absentEdgeType must be a non-empty string`);
  }
  assertNoCanonicalId(anti.absentEdgeType, `${where}.absentEdgeType`);
  if (!ANTI_JOIN_CORRELATES.includes(anti.correlate)) {
    throw new ModelError(
      `${where}.correlate must be one of ${ANTI_JOIN_CORRELATES.join(' | ')}; got ${JSON.stringify(anti.correlate)}`,
    );
  }
  for (const arrKey of ['absentFromTypes', 'absentToTypes']) {
    if (anti[arrKey] !== undefined) {
      if (!Array.isArray(anti[arrKey]) || anti[arrKey].length === 0) {
        throw new ModelError(`${where}.${arrKey} must be a non-empty array`);
      }
      anti[arrKey].forEach((t, i) => {
        if (typeof t !== 'string' || t.length === 0) {
          throw new ModelError(`${where}.${arrKey}[${i}] must be a non-empty string`);
        }
        assertNoCanonicalId(t, `${where}.${arrKey}[${i}]`);
      });
    }
  }
  if (anti.absentEdgeWhereProperty !== undefined) {
    assertWhereMapping(anti.absentEdgeWhereProperty, `${where}.absentEdgeWhereProperty`);
  }
  if (anti.absentFromWhereProperty !== undefined) {
    if (Array.isArray(anti.absentFromWhereProperty)) {
      if (anti.absentFromWhereProperty.length === 0) {
        throw new ModelError(`${where}.absentFromWhereProperty must be a non-empty array`);
      }
      anti.absentFromWhereProperty.forEach((c, i) =>
        assertWhereClause(c, `${where}.absentFromWhereProperty[${i}]`),
      );
    } else {
      assertWhereClause(anti.absentFromWhereProperty, `${where}.absentFromWhereProperty`);
    }
  }
  if (anti.absentToWhereProperty !== undefined) {
    if (Array.isArray(anti.absentToWhereProperty)) {
      if (anti.absentToWhereProperty.length === 0) {
        throw new ModelError(`${where}.absentToWhereProperty must be a non-empty array`);
      }
      anti.absentToWhereProperty.forEach((c, i) =>
        assertWhereClause(c, `${where}.absentToWhereProperty[${i}]`),
      );
    } else {
      assertWhereClause(anti.absentToWhereProperty, `${where}.absentToWhereProperty`);
    }
  }
  if (anti.absentFromPhaseIn !== undefined) {
    if (!Array.isArray(anti.absentFromPhaseIn) || anti.absentFromPhaseIn.length === 0) {
      throw new ModelError(`${where}.absentFromPhaseIn must be a non-empty array`);
    }
    anti.absentFromPhaseIn.forEach((p, i) => {
      if (!ANTI_JOIN_PHASES.includes(p)) {
        throw new ModelError(
          `${where}.absentFromPhaseIn[${i}] must be one of ${ANTI_JOIN_PHASES.join(' | ')}; got ${JSON.stringify(p)}`,
        );
      }
    });
  }
}

/**
 * Validate one `setDifference` RuleSetDifference (EC-9): only allowed keys,
 * required present, edge types non-empty strings, optional type arrays / where
 * filters / requireBothNonEmpty well-typed. Throws `ModelError`.
 */
function assertSetDifference(sd, where) {
  if (sd === null || typeof sd !== 'object' || Array.isArray(sd)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(sd);
  const unknown = keys.filter((k) => !SET_DIFFERENCE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = SET_DIFFERENCE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['includeEdgeType', 'subtractEdgeType']) {
    if (typeof sd[k] !== 'string' || sd[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(sd[k], `${where}.${k}`);
  }
  for (const arrKey of ['includeToTypes', 'subtractToTypes']) {
    if (sd[arrKey] !== undefined) {
      if (!Array.isArray(sd[arrKey]) || sd[arrKey].length === 0) {
        throw new ModelError(`${where}.${arrKey} must be a non-empty array`);
      }
      sd[arrKey].forEach((t, i) => {
        if (typeof t !== 'string' || t.length === 0) {
          throw new ModelError(`${where}.${arrKey}[${i}] must be a non-empty string`);
        }
        assertNoCanonicalId(t, `${where}.${arrKey}[${i}]`);
      });
    }
  }
  if (sd.includeEdgeWhereProperty !== undefined) {
    assertWhereMapping(sd.includeEdgeWhereProperty, `${where}.includeEdgeWhereProperty`);
  }
  if (sd.subtractEdgeWhereProperty !== undefined) {
    assertWhereMapping(sd.subtractEdgeWhereProperty, `${where}.subtractEdgeWhereProperty`);
  }
  if (sd.requireBothNonEmpty !== undefined && typeof sd.requireBothNonEmpty !== 'boolean') {
    throw new ModelError(`${where}.requireBothNonEmpty must be a boolean`);
  }
}

/**
 * Validate one `propertyCompare` RulePropertyCompare (EC-12): only allowed keys,
 * required present, keys non-empty strings (no canonical ids), op + rankTable in
 * their closed sets. Throws `ModelError`.
 */
function assertPropertyCompare(pc, where) {
  if (pc === null || typeof pc !== 'object' || Array.isArray(pc)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(pc);
  const unknown = keys.filter((k) => !PROPERTY_COMPARE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = PROPERTY_COMPARE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['leftKey', 'rightKey']) {
    if (typeof pc[k] !== 'string' || pc[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(pc[k], `${where}.${k}`);
  }
  if (!PROPERTY_COMPARE_OPS.includes(pc.op)) {
    throw new ModelError(
      `${where}.op must be one of ${PROPERTY_COMPARE_OPS.join(' | ')}; got ${JSON.stringify(pc.op)}`,
    );
  }
  if (!PROPERTY_COMPARE_RANK_TABLES.includes(pc.rankTable)) {
    throw new ModelError(
      `${where}.rankTable must be one of ${PROPERTY_COMPARE_RANK_TABLES.join(' | ')}; got ${JSON.stringify(pc.rankTable)}`,
    );
  }
}

/**
 * Validate one `fieldJoin` RuleFieldJoin (EC-10): nameProperty required;
 * optional orphanSetDiff with required array/element keys and optional
 * equals-only rightElementWhere. Throws `ModelError`.
 */
function assertFieldJoin(fj, where) {
  if (fj === null || typeof fj !== 'object' || Array.isArray(fj)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(fj);
  const unknown = keys.filter((k) => !FIELD_JOIN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = FIELD_JOIN_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  if (typeof fj.nameProperty !== 'string' || fj.nameProperty.length === 0) {
    throw new ModelError(`${where}.nameProperty must be a non-empty string`);
  }
  assertNoCanonicalId(fj.nameProperty, `${where}.nameProperty`);
  if (fj.orphanSetDiff !== undefined) {
    const od = fj.orphanSetDiff;
    if (od === null || typeof od !== 'object' || Array.isArray(od)) {
      throw new ModelError(`${where}.orphanSetDiff must be a mapping`);
    }
    const odKeys = Object.keys(od);
    const odUnknown = odKeys.filter((k) => !FIELD_JOIN_ORPHAN_KEYS.includes(k));
    if (odUnknown.length > 0) {
      throw new ModelError(`${where}.orphanSetDiff: unknown key(s): ${odUnknown.join(', ')}`);
    }
    const odMissing = FIELD_JOIN_ORPHAN_REQUIRED_KEYS.filter((k) => !odKeys.includes(k));
    if (odMissing.length > 0) {
      throw new ModelError(
        `${where}.orphanSetDiff: missing required key(s): ${odMissing.join(', ')}`,
      );
    }
    for (const k of FIELD_JOIN_ORPHAN_REQUIRED_KEYS) {
      if (typeof od[k] !== 'string' || od[k].length === 0) {
        throw new ModelError(`${where}.orphanSetDiff.${k} must be a non-empty string`);
      }
      assertNoCanonicalId(od[k], `${where}.orphanSetDiff.${k}`);
    }
    if (od.rightElementWhere !== undefined) {
      assertWhereMapping(od.rightElementWhere, `${where}.orphanSetDiff.rightElementWhere`);
    }
  }
}

/**
 * Validate one `propertyEqualsEndpoint` RulePropertyEqualsEndpoint (D9): only
 * allowed keys, required present, `nodeProperty` / `endpointEdgeType` non-empty
 * strings (no canonical ids), `relation` in the closed set, optional
 * `endpointEdgeWhereProperty` (a WhereClause or AND-array, operator-class) and
 * optional `excludeInactive` boolean. Throws `ModelError`.
 */
function assertPropertyEqualsEndpoint(pee, where) {
  if (pee === null || typeof pee !== 'object' || Array.isArray(pee)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(pee);
  const unknown = keys.filter((k) => !PROPERTY_EQUALS_ENDPOINT_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = PROPERTY_EQUALS_ENDPOINT_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  for (const k of ['nodeProperty', 'endpointEdgeType']) {
    if (typeof pee[k] !== 'string' || pee[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(pee[k], `${where}.${k}`);
  }
  if (!PROPERTY_EQUALS_ENDPOINT_RELATIONS.includes(pee.relation)) {
    throw new ModelError(
      `${where}.relation must be one of ${PROPERTY_EQUALS_ENDPOINT_RELATIONS.join(' | ')}; got ${JSON.stringify(pee.relation)}`,
    );
  }
  if (pee.endpointEdgeWhereProperty !== undefined) {
    if (Array.isArray(pee.endpointEdgeWhereProperty)) {
      if (pee.endpointEdgeWhereProperty.length === 0) {
        throw new ModelError(`${where}.endpointEdgeWhereProperty must be a non-empty array`);
      }
      pee.endpointEdgeWhereProperty.forEach((c, i) =>
        assertWhereClause(c, `${where}.endpointEdgeWhereProperty[${i}]`),
      );
    } else {
      assertWhereClause(pee.endpointEdgeWhereProperty, `${where}.endpointEdgeWhereProperty`);
    }
  }
  if (pee.excludeInactive !== undefined && typeof pee.excludeInactive !== 'boolean') {
    throw new ModelError(`${where}.excludeInactive must be a boolean`);
  }
}

/**
 * Validate one `witnessPartition` (edge-rule primary-vs-witness plane guard):
 * only allowed keys, the always-required subset present, `roleEndpoint` +
 * `witnessKind` (when present) in their closed sets, and — in `property` mode —
 * a non-empty `witnessProperty` (which must be ABSENT in `inactive-firer` mode,
 * since the liveness predicate needs no single property). Both templates are
 * non-empty strings with no canonical ids. Throws `ModelError`. Only meaningful
 * for an EDGE rule (the caller cross-checks `bind.edgeType`).
 */
function assertWitnessPartition(wp, where) {
  if (wp === null || typeof wp !== 'object' || Array.isArray(wp)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(wp);
  const missing = WITNESS_PARTITION_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  const unknown = keys.filter((k) => !WITNESS_PARTITION_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  if (!WITNESS_ROLE_ENDPOINTS.includes(wp.roleEndpoint)) {
    throw new ModelError(
      `${where}.roleEndpoint must be one of ${WITNESS_ROLE_ENDPOINTS.join(' | ')}; got ${JSON.stringify(wp.roleEndpoint)}`,
    );
  }
  // `witnessKind` defaults to `property` when omitted (the async guard).
  const witnessKind = wp.witnessKind ?? 'property';
  if (wp.witnessKind !== undefined && !WITNESS_KINDS.includes(wp.witnessKind)) {
    throw new ModelError(
      `${where}.witnessKind must be one of ${WITNESS_KINDS.join(' | ')}; got ${JSON.stringify(wp.witnessKind)}`,
    );
  }
  // `witnessProperty` is REQUIRED in `property` mode, FORBIDDEN otherwise.
  if (witnessKind === 'property') {
    if (typeof wp.witnessProperty !== 'string' || wp.witnessProperty.length === 0) {
      throw new ModelError(`${where}.witnessProperty must be a non-empty string in 'property' mode`);
    }
    assertNoCanonicalId(wp.witnessProperty, `${where}.witnessProperty`);
  } else if (wp.witnessProperty !== undefined) {
    throw new ModelError(
      `${where}.witnessProperty must be omitted in '${witnessKind}' mode (its predicate uses no single boolean property)`,
    );
  }
  // `witnessArrayProperty` (a string) + `witnessArrayMember` (a non-empty string
  // array) are REQUIRED in `system-perm-holder` mode, FORBIDDEN otherwise.
  if (witnessKind === 'system-perm-holder') {
    if (typeof wp.witnessArrayProperty !== 'string' || wp.witnessArrayProperty.length === 0) {
      throw new ModelError(`${where}.witnessArrayProperty must be a non-empty string in 'system-perm-holder' mode`);
    }
    assertNoCanonicalId(wp.witnessArrayProperty, `${where}.witnessArrayProperty`);
    if (!Array.isArray(wp.witnessArrayMember) || wp.witnessArrayMember.length === 0) {
      throw new ModelError(`${where}.witnessArrayMember must be a non-empty array in 'system-perm-holder' mode`);
    }
    wp.witnessArrayMember.forEach((m, i) => {
      if (typeof m !== 'string' || m.length === 0) {
        throw new ModelError(`${where}.witnessArrayMember[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(m, `${where}.witnessArrayMember[${i}]`);
    });
  } else {
    for (const k of ['witnessArrayProperty', 'witnessArrayMember']) {
      if (wp[k] !== undefined) {
        throw new ModelError(`${where}.${k} must be omitted in '${witnessKind}' mode (only 'system-perm-holder' uses it)`);
      }
    }
  }
  for (const k of ['interpretationWitnessOnly', 'interpretationMixedWitnessSuffix']) {
    if (typeof wp[k] !== 'string' || wp[k].length === 0) {
      throw new ModelError(`${where}.${k} must be a non-empty string`);
    }
    assertNoCanonicalId(wp[k], `${where}.${k}`);
  }
}

/**
 * Validate one `remediation` RuleRemediation (CITED-REMEDIATION): only allowed
 * keys, `steps` a non-empty array of non-empty strings (no canonical ids — the
 * fix is org-agnostic general guidance, exactly like `interpretation`), and an
 * optional `whatIfTool` non-empty string (no canonical id). Throws `ModelError`.
 */
function assertRemediation(rem, where) {
  if (rem === null || typeof rem !== 'object' || Array.isArray(rem)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(rem);
  const unknown = keys.filter((k) => !REMEDIATION_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = REMEDIATION_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  if (!Array.isArray(rem.steps) || rem.steps.length === 0) {
    throw new ModelError(`${where}.steps must be a non-empty array`);
  }
  rem.steps.forEach((s, i) => {
    if (typeof s !== 'string' || s.length === 0) {
      throw new ModelError(`${where}.steps[${i}] must be a non-empty string`);
    }
    assertNoCanonicalId(s, `${where}.steps[${i}]`);
  });
  if (rem.whatIfTool !== undefined) {
    if (typeof rem.whatIfTool !== 'string' || rem.whatIfTool.length === 0) {
      throw new ModelError(`${where}.whatIfTool must be a non-empty string when present`);
    }
    assertNoCanonicalId(rem.whatIfTool, `${where}.whatIfTool`);
  }
}

/**
 * Validate a `{ key, equals }` where-mapping (shared by an aggregate's
 * endpoint and counted-edge property filters): exactly `key`/`equals`, `key` a
 * non-empty string, `equals` a scalar, and no canonical ids in either.
 */
function assertWhereMapping(w, where) {
  if (w === null || typeof w !== 'object' || Array.isArray(w)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const wKeys = Object.keys(w);
  const wMissing = WHERE_KEYS.filter((k) => !wKeys.includes(k));
  if (wMissing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${wMissing.join(', ')}`);
  }
  const wUnknown = wKeys.filter((k) => !WHERE_KEYS.includes(k));
  if (wUnknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${wUnknown.join(', ')}`);
  }
  if (typeof w.key !== 'string' || w.key.length === 0) {
    throw new ModelError(`${where}.key must be a non-empty string`);
  }
  assertNoCanonicalId(w.key, `${where}.key`);
  const eqt = typeof w.equals;
  if (eqt !== 'string' && eqt !== 'number' && eqt !== 'boolean') {
    throw new ModelError(`${where}.equals must be a string, number, or boolean`);
  }
  assertNoCanonicalId(w.equals, `${where}.equals`);
}

/**
 * Validate ONE `anyElement` INNER clause (`ArrayElementClause`) — the existential
 * array-element matcher's operand. Requires EXACTLY ONE scalar operator from
 * {@link WHERE_INNER_OPERATORS} (`equals` / `neq` scalar; `in` / `notIn` a
 * NON-EMPTY scalar array) and an OPTIONAL `key` (present ⇒ object-element mode,
 * matches `element[key]`; absent ⇒ scalar-array mode, matches the element itself).
 * `isNull` and a nested `anyElement` are NOT valid inner operators (the inner is a
 * flat scalar comparison). `key`, when present, is a non-empty string; NO operand
 * (inner key or comparison value) is a canonical id. Throws `ModelError`.
 */
function assertAnyElementClause(inner, where) {
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(inner);
  const operators = keys.filter((k) => WHERE_INNER_OPERATORS.includes(k));
  if (operators.length === 0) {
    throw new ModelError(
      `${where}: exactly one operator (${WHERE_INNER_OPERATORS.join(' | ')}) is required; got none`,
    );
  }
  // Only `key` (optional) plus the inner scalar operators are allowed — an outer
  // operator (`isNull`) or a nested `anyElement` here is `unknown`.
  const unknown = keys.filter((k) => k !== 'key' && !WHERE_INNER_OPERATORS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  if (operators.length > 1) {
    throw new ModelError(
      `${where}: exactly one operator (${WHERE_INNER_OPERATORS.join(' | ')}) is required; got ${operators.join(', ')}`,
    );
  }
  // `key` is OPTIONAL. Present ⇒ object-element mode; absent ⇒ scalar-array mode.
  if ('key' in inner) {
    if (typeof inner.key !== 'string' || inner.key.length === 0) {
      throw new ModelError(`${where}.key must be a non-empty string`);
    }
    assertNoCanonicalId(inner.key, `${where}.key`);
  }
  const op = operators[0];
  if (WHERE_ARRAY_OPERATORS.includes(op)) {
    if (!Array.isArray(inner[op]) || inner[op].length === 0) {
      throw new ModelError(`${where}.${op} must be a non-empty array`);
    }
    inner[op].forEach((v, i) => {
      const vt = typeof v;
      if (vt !== 'string' && vt !== 'number' && vt !== 'boolean') {
        throw new ModelError(`${where}.${op}[${i}] must be a string, number, or boolean`);
      }
      assertNoCanonicalId(v, `${where}.${op}[${i}]`);
    });
  } else {
    const vt = typeof inner[op];
    if (vt !== 'string' && vt !== 'number' && vt !== 'boolean') {
      throw new ModelError(`${where}.${op} must be a string, number, or boolean`);
    }
    assertNoCanonicalId(inner[op], `${where}.${op}`);
  }
}

/**
 * Validate ONE `whereProperty` clause — the operator-class matcher. Requires a
 * `key` and EXACTLY ONE operator from {@link WHERE_OPERATORS}. `equals` / `neq`
 * take a scalar (string/number/boolean); `in` / `notIn` take a NON-EMPTY array of
 * scalars; `isNull` / `isEmpty` take a BOOLEAN (`true`/`false` — nullish
 * present/absent, or empty-array polarity); `anyElement` takes a nested
 * {@link ArrayElementClause} (the existential array-element matcher, validated by
 * {@link assertAnyElementClause}). `key` is a non-empty string; NO operand
 * (scalar, array element, or inner operand) is a canonical id. Any other key is
 * unknown. Throws `ModelError`.
 *
 * The check ORDER and messages are chosen so the scalar-`equals` path is
 * BYTE-IDENTICAL to the pre-operator inline branch (a bare `{ key }` still reports
 * `missing required key(s): equals`; a non-scalar equals still reports
 * `.equals must be a string, number, or boolean`) — so the existing validator
 * tests are unchanged. Only `whereProperty` uses this; `edgeWhereProperty` and the
 * aggregate filters stay equals-only via {@link assertWhereMapping}.
 */
function assertWhereClause(w, where) {
  if (w === null || typeof w !== 'object' || Array.isArray(w)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(w);
  const operators = keys.filter((k) => WHERE_OPERATORS.includes(k));
  // `key` is always required; a clause needs exactly one operator. A bare
  // `{ key }` (no operator) surfaces the DEFAULT `equals` in the missing list so
  // the message matches the pre-operator branch verbatim.
  const missing = [];
  if (!keys.includes('key')) missing.push('key');
  if (operators.length === 0) missing.push('equals');
  if (missing.length > 0) {
    throw new ModelError(`${where}: missing required key(s): ${missing.join(', ')}`);
  }
  const unknown = keys.filter((k) => k !== 'key' && !WHERE_OPERATORS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  if (operators.length > 1) {
    throw new ModelError(
      `${where}: exactly one operator (${WHERE_OPERATORS.join(' | ')}) is required; got ${operators.join(', ')}`,
    );
  }
  if (typeof w.key !== 'string' || w.key.length === 0) {
    throw new ModelError(`${where}.key must be a non-empty string`);
  }
  assertNoCanonicalId(w.key, `${where}.key`);
  const op = operators[0];
  if (WHERE_ELEMENT_OPERATORS.includes(op)) {
    // `anyElement` — the EXISTENTIAL array-element matcher. Its operand is a
    // nested inner clause (`ArrayElementClause`), validated recursively, NOT a
    // scalar / array / boolean. The `key` above was already checked; the inner
    // clause carries its OWN optional `key` + exactly one scalar operator.
    assertAnyElementClause(w[op], `${where}.${op}`);
  } else if (WHERE_ARRAY_OPERATORS.includes(op)) {
    if (!Array.isArray(w[op]) || w[op].length === 0) {
      throw new ModelError(`${where}.${op} must be a non-empty array`);
    }
    w[op].forEach((v, i) => {
      const vt = typeof v;
      if (vt !== 'string' && vt !== 'number' && vt !== 'boolean') {
        throw new ModelError(`${where}.${op}[${i}] must be a string, number, or boolean`);
      }
      assertNoCanonicalId(v, `${where}.${op}[${i}]`);
    });
  } else if (WHERE_BOOLEAN_OPERATORS.includes(op)) {
    // `isNull` (nullish present/absent) and `isEmpty` (empty-array polarity) take
    // a plain boolean (never a canonical id, so no id scan). The existing scalar
    // operand check for equals/neq is LEFT UNTOUCHED below.
    if (typeof w[op] !== 'boolean') {
      throw new ModelError(`${where}.${op} must be a boolean (true or false)`);
    }
  } else {
    const vt = typeof w[op];
    if (vt !== 'string' && vt !== 'number' && vt !== 'boolean') {
      throw new ModelError(`${where}.${op} must be a string, number, or boolean`);
    }
    assertNoCanonicalId(w[op], `${where}.${op}`);
  }
}

/**
 * Validate one structural `bind` RulePredicate: only allowed keys, at least one
 * predicate field, each field well-typed, no canonical ids. Throws `ModelError`.
 */
export function assertBind(bind, where) {
  if (bind === null || typeof bind !== 'object' || Array.isArray(bind)) {
    throw new ModelError(`${where} must be a mapping`);
  }
  const keys = Object.keys(bind);
  const unknown = keys.filter((k) => !BIND_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ModelError(`${where}: unknown key(s): ${unknown.join(', ')}`);
  }
  if (keys.length === 0) {
    throw new ModelError(`${where} must have at least one predicate field (${BIND_KEYS.join(' | ')})`);
  }

  if (bind.edgeType !== undefined) {
    if (typeof bind.edgeType !== 'string' || bind.edgeType.length === 0) {
      throw new ModelError(`${where}.edgeType must be a non-empty string`);
    }
    assertNoCanonicalId(bind.edgeType, `${where}.edgeType`);
  }
  if (bind.componentTypes !== undefined) {
    if (!Array.isArray(bind.componentTypes) || bind.componentTypes.length === 0) {
      throw new ModelError(`${where}.componentTypes must be a non-empty array`);
    }
    bind.componentTypes.forEach((t, i) => {
      if (typeof t !== 'string' || t.length === 0) {
        throw new ModelError(`${where}.componentTypes[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(t, `${where}.componentTypes[${i}]`);
    });
  }
  if (bind.conditionKind !== undefined) {
    if (!CONDITION_KINDS.includes(bind.conditionKind)) {
      throw new ModelError(
        `${where}.conditionKind must be one of ${CONDITION_KINDS.join(' | ')}; got ${JSON.stringify(bind.conditionKind)}`,
      );
    }
  }
  if (bind.whereProperty !== undefined) {
    // Polymorphic: a single {@link WhereClause} OR a NON-EMPTY array of them,
    // AND-ed. Every clause is validated by the shared `assertWhereClause`, which
    // accepts the operator-class forms (`in` / `notIn` / `neq`) AND keeps the
    // scalar-`equals` error strings byte-identical to the pre-operator branch, so
    // the existing validator tests are unchanged.
    if (Array.isArray(bind.whereProperty)) {
      if (bind.whereProperty.length === 0) {
        throw new ModelError(`${where}.whereProperty must be a non-empty array`);
      }
      bind.whereProperty.forEach((el, i) => {
        assertWhereClause(el, `${where}.whereProperty[${i}]`);
      });
    } else {
      assertWhereClause(bind.whereProperty, `${where}.whereProperty`);
    }
  }
  if (bind.edgeWhereProperty !== undefined) {
    const ewp = bind.edgeWhereProperty;
    if (ewp === null || typeof ewp !== 'object' || Array.isArray(ewp)) {
      throw new ModelError(`${where}.edgeWhereProperty must be a mapping`);
    }
    const ewpKeys = Object.keys(ewp);
    const ewpMissing = WHERE_KEYS.filter((k) => !ewpKeys.includes(k));
    if (ewpMissing.length > 0) {
      throw new ModelError(`${where}.edgeWhereProperty: missing required key(s): ${ewpMissing.join(', ')}`);
    }
    const ewpUnknown = ewpKeys.filter((k) => !WHERE_KEYS.includes(k));
    if (ewpUnknown.length > 0) {
      throw new ModelError(`${where}.edgeWhereProperty: unknown key(s): ${ewpUnknown.join(', ')}`);
    }
    if (typeof ewp.key !== 'string' || ewp.key.length === 0) {
      throw new ModelError(`${where}.edgeWhereProperty.key must be a non-empty string`);
    }
    assertNoCanonicalId(ewp.key, `${where}.edgeWhereProperty.key`);
    const eet = typeof ewp.equals;
    if (eet !== 'string' && eet !== 'number' && eet !== 'boolean') {
      throw new ModelError(`${where}.edgeWhereProperty.equals must be a string, number, or boolean`);
    }
    assertNoCanonicalId(ewp.equals, `${where}.edgeWhereProperty.equals`);
  }
  if (bind.toWhereProperty !== undefined) {
    if (Array.isArray(bind.toWhereProperty)) {
      if (bind.toWhereProperty.length === 0) {
        throw new ModelError(`${where}.toWhereProperty must be a non-empty array`);
      }
      bind.toWhereProperty.forEach((el, i) => {
        assertWhereClause(el, `${where}.toWhereProperty[${i}]`);
      });
    } else {
      assertWhereClause(bind.toWhereProperty, `${where}.toWhereProperty`);
    }
  }
  if (bind.fromWhereProperty !== undefined) {
    if (Array.isArray(bind.fromWhereProperty)) {
      if (bind.fromWhereProperty.length === 0) {
        throw new ModelError(`${where}.fromWhereProperty must be a non-empty array`);
      }
      bind.fromWhereProperty.forEach((el, i) => {
        assertWhereClause(el, `${where}.fromWhereProperty[${i}]`);
      });
    } else {
      assertWhereClause(bind.fromWhereProperty, `${where}.fromWhereProperty`);
    }
  }
  if (bind.toObjectIn !== undefined) {
    if (!Array.isArray(bind.toObjectIn) || bind.toObjectIn.length === 0) {
      throw new ModelError(`${where}.toObjectIn must be a non-empty array`);
    }
    bind.toObjectIn.forEach((name, i) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new ModelError(`${where}.toObjectIn[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(name, `${where}.toObjectIn[${i}]`);
    });
  }
  for (const typeKey of ['toTypeIn', 'fromTypeIn']) {
    if (bind[typeKey] !== undefined) {
      if (!Array.isArray(bind[typeKey]) || bind[typeKey].length === 0) {
        throw new ModelError(`${where}.${typeKey} must be a non-empty array`);
      }
      bind[typeKey].forEach((name, i) => {
        if (typeof name !== 'string' || name.length === 0) {
          throw new ModelError(`${where}.${typeKey}[${i}] must be a non-empty string`);
        }
        assertNoCanonicalId(name, `${where}.${typeKey}[${i}]`);
      });
    }
  }
  if (bind.order !== undefined) {
    if (typeof bind.order !== 'number' || !Number.isInteger(bind.order)) {
      throw new ModelError(`${where}.order must be an integer`);
    }
  }
  if (bind.join !== undefined) {
    assertJoin(bind.join, `${where}.join`);
  }
  if (bind.aggregate !== undefined) {
    assertAggregate(bind.aggregate, `${where}.aggregate`);
  }
  if (bind.dualEdge !== undefined) {
    assertDualEdge(bind.dualEdge, `${where}.dualEdge`);
  }
  if (bind.antiJoin !== undefined) {
    assertAntiJoin(bind.antiJoin, `${where}.antiJoin`);
  }
  if (bind.setDifference !== undefined) {
    assertSetDifference(bind.setDifference, `${where}.setDifference`);
  }
  if (bind.propertyCompare !== undefined) {
    assertPropertyCompare(bind.propertyCompare, `${where}.propertyCompare`);
  }
  if (bind.fieldJoin !== undefined) {
    assertFieldJoin(bind.fieldJoin, `${where}.fieldJoin`);
  }
  if (bind.propertyEqualsEndpoint !== undefined) {
    assertPropertyEqualsEndpoint(bind.propertyEqualsEndpoint, `${where}.propertyEqualsEndpoint`);
  }
  if (bind.crossObjectCascade !== undefined) {
    assertCrossObjectCascade(bind.crossObjectCascade, `${where}.crossObjectCascade`);
  }
  const multiPaths = [
    bind.join,
    bind.aggregate,
    bind.dualEdge,
    bind.antiJoin,
    bind.setDifference,
    bind.propertyCompare,
    bind.fieldJoin,
    bind.propertyEqualsEndpoint,
    bind.crossObjectCascade,
  ].filter((x) => x !== undefined);
  if (multiPaths.length > 1) {
    throw new ModelError(
      `${where}: join, aggregate, dualEdge, antiJoin, setDifference, propertyCompare, fieldJoin, propertyEqualsEndpoint, and crossObjectCascade are mutually exclusive`,
    );
  }
}

/**
 * Parse + structurally validate the curated RM-2 concept-rules. Cross-checks
 * every rule's `concept` against the concept dictionary (so a rule can never
 * bind a concept that does not exist). Returns the ORDERED array preserving
 * YAML document order. Throws `ModelError` on any violation.
 */
export function loadConceptRules() {
  const validConceptIds = new Set(Object.keys(loadConcepts()));

  const doc = yaml.load(readFileSync(CONCEPT_RULES_PATH, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ModelError('concept-rules.yaml must be a mapping at the top level');
  }
  const topKeys = Object.keys(doc);
  if (topKeys.length !== 1 || topKeys[0] !== 'conceptRules') {
    throw new ModelError(
      `concept-rules.yaml must have exactly one top-level key "conceptRules"; found: ${topKeys.join(', ')}`,
    );
  }
  const rules = doc.conceptRules;
  if (!Array.isArray(rules)) {
    throw new ModelError('conceptRules must be a sequence (array)');
  }
  if (rules.length === 0) {
    throw new ModelError('conceptRules is empty');
  }

  const seenIds = new Set();
  rules.forEach((rule, idx) => {
    const w = `conceptRules[${idx}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new ModelError(`${w} must be a mapping`);
    }
    const keys = Object.keys(rule);
    const missing = RULE_KEYS.filter((k) => !keys.includes(k));
    if (missing.length > 0) {
      throw new ModelError(`${w}: missing required key(s): ${missing.join(', ')}`);
    }
    const unknown = keys.filter((k) => !RULE_ALLOWED_KEYS.includes(k));
    if (unknown.length > 0) {
      throw new ModelError(`${w}: unknown key(s): ${unknown.join(', ')}`);
    }

    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new ModelError(`${w}.id must be a non-empty string`);
    }
    assertNoCanonicalId(rule.id, `${w}.id`);
    if (seenIds.has(rule.id)) {
      throw new ModelError(`${w}.id duplicate rule id: ${JSON.stringify(rule.id)}`);
    }
    seenIds.add(rule.id);

    if (typeof rule.concept !== 'string' || rule.concept.length === 0) {
      throw new ModelError(`${w}.concept must be a non-empty string`);
    }
    assertNoCanonicalId(rule.concept, `${w}.concept`);
    if (!validConceptIds.has(rule.concept)) {
      throw new ModelError(
        `${w}.concept references unknown concept id: ${JSON.stringify(rule.concept)} (not in concepts.yaml)`,
      );
    }

    assertBind(rule.bind, `${w}.bind`);

    if (typeof rule.interpretation !== 'string' || rule.interpretation.length === 0) {
      throw new ModelError(`${w}.interpretation must be a non-empty string`);
    }
    assertNoCanonicalId(rule.interpretation, `${w}.interpretation`);

    if (rule.interpretationCrossPhase !== undefined) {
      if (typeof rule.interpretationCrossPhase !== 'string' || rule.interpretationCrossPhase.length === 0) {
        throw new ModelError(`${w}.interpretationCrossPhase must be a non-empty string when present`);
      }
      assertNoCanonicalId(rule.interpretationCrossPhase, `${w}.interpretationCrossPhase`);
    }

    if (rule.witnessPartition !== undefined) {
      // The guard classifies matched EDGES by an endpoint node property, so it is
      // only meaningful on an edge-shaped rule.
      if (rule.bind === null || typeof rule.bind !== 'object' || rule.bind.edgeType === undefined) {
        throw new ModelError(`${w}.witnessPartition requires ${w}.bind.edgeType (edge-shaped rule)`);
      }
      assertWitnessPartition(rule.witnessPartition, `${w}.witnessPartition`);
    }

    if (rule.remediation !== undefined) {
      assertRemediation(rule.remediation, `${w}.remediation`);
    }

    if (!CONFIDENCE_LEVELS.includes(rule.maxConfidence)) {
      throw new ModelError(
        `${w}.maxConfidence must be one of ${CONFIDENCE_LEVELS.join(' | ')}; got ${JSON.stringify(rule.maxConfidence)}`,
      );
    }
    if (typeof rule.absenceShaped !== 'boolean') {
      throw new ModelError(`${w}.absenceShaped must be a boolean`);
    }

    if (!Array.isArray(rule.dependsOnCoverage)) {
      throw new ModelError(`${w}.dependsOnCoverage must be an array`);
    }
    rule.dependsOnCoverage.forEach((t, i) => {
      if (typeof t !== 'string' || t.length === 0) {
        throw new ModelError(`${w}.dependsOnCoverage[${i}] must be a non-empty string`);
      }
      assertNoCanonicalId(t, `${w}.dependsOnCoverage[${i}]`);
    });
  });

  return rules;
}

/** Emit a single-quoted TypeScript string literal. */
function tsStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Render one `{category, verdict}` pair as an inline TypeScript object literal. */
function renderVerdictPair(pair) {
  return `{ category: ${tsStr(pair.category)}, verdict: ${tsStr(pair.verdict)} }`;
}

/**
 * Render the frozen `EDGE_SEMANTICS` object literal from the curated model.
 * Keys are emitted in YAML document order (deterministic).
 */
function renderEdgeSemantics(es) {
  const lines = [];
  lines.push('export const EDGE_SEMANTICS: EdgeSemantics = Object.freeze({');
  lines.push('  bySource: [');
  for (const entry of es.bySource) {
    lines.push('    {');
    lines.push(`      source: ${tsStr(entry.source)},`);
    lines.push(`      edgeType: ${tsStr(entry.edgeType)},`);
    if (entry.fromType !== undefined) {
      lines.push(`      fromType: ${tsStr(entry.fromType)},`);
    }
    lines.push(`      category: ${tsStr(entry.category)},`);
    lines.push(`      verdict: ${tsStr(entry.verdict)},`);
    lines.push('    },');
  }
  lines.push('  ],');
  lines.push('  byEdgeType: {');
  for (const edgeType of Object.keys(es.byEdgeType)) {
    const rule = es.byEdgeType[edgeType];
    lines.push(`    ${edgeType}: {`);
    const sourceKeys = Object.keys(rule.bySourceType);
    if (sourceKeys.length === 0) {
      lines.push('      bySourceType: {},');
    } else {
      lines.push('      bySourceType: {');
      for (const sourceType of sourceKeys) {
        lines.push(`        ${sourceType}: ${renderVerdictPair(rule.bySourceType[sourceType])},`);
      }
      lines.push('      },');
    }
    lines.push(`      default: ${renderVerdictPair(rule.default)},`);
    lines.push('    },');
  }
  lines.push('  },');
  lines.push(`  default: ${renderVerdictPair(es.default)},`);
  lines.push('});');
  return lines.join('\n');
}

/** Render one scalar (`string` → quoted, `number`/`boolean` → verbatim). */
function renderScalar(v) {
  return typeof v === 'string' ? tsStr(v) : String(v);
}

/**
 * Render one `join` RuleJoin as an inline TypeScript literal. Field order is
 * fixed (matching the contract declaration) so the emitted artifact is
 * deterministic regardless of YAML key order.
 */
function renderJoin(join) {
  const parts = [`throughType: ${tsStr(join.throughType)}`];
  if (join.throughConditionKinds !== undefined) {
    parts.push(`throughConditionKinds: [${join.throughConditionKinds.map(tsStr).join(', ')}]`);
  }
  parts.push(`throughKeyArray: ${tsStr(join.throughKeyArray)}`);
  parts.push(`writeEdgeType: ${tsStr(join.writeEdgeType)}`);
  if (join.writerTypes !== undefined) {
    parts.push(`writerTypes: [${join.writerTypes.map(tsStr).join(', ')}]`);
  }
  parts.push(`sameObject: ${join.sameObject}`);
  parts.push(`excludeSelf: ${join.excludeSelf}`);
  if (join.excludeInactiveFirer !== undefined) {
    parts.push(`excludeInactiveFirer: ${join.excludeInactiveFirer}`);
  }
  if (join.excludeTestWriter !== undefined) {
    parts.push(`excludeTestWriter: ${join.excludeTestWriter}`);
  }
  if (join.excludeInactiveWriter !== undefined) {
    parts.push(`excludeInactiveWriter: ${join.excludeInactiveWriter}`);
  }
  if (join.phaseFilter !== undefined) {
    parts.push(`phaseFilter: ${tsStr(join.phaseFilter)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `aggregate` RuleAggregate as an inline TypeScript literal. Field
 * order is fixed (matching the contract declaration) so the emitted artifact is
 * deterministic regardless of YAML key order.
 */
function renderAggregate(agg) {
  const parts = [];
  if (agg.groupByEdgeProperty !== undefined) {
    parts.push(`groupByEdgeProperty: ${tsStr(agg.groupByEdgeProperty)}`);
  }
  if (agg.eventSplitByProperty !== undefined) {
    parts.push(`eventSplitByProperty: ${tsStr(agg.eventSplitByProperty)}`);
  }
  if (agg.edgeSource !== undefined) {
    parts.push(`edgeSource: ${tsStr(agg.edgeSource)}`);
  }
  if (agg.endpointWhereProperty !== undefined) {
    parts.push(`endpointWhereProperty: ${renderWhereClause(agg.endpointWhereProperty)}`);
  }
  if (agg.countedEdgeWhereProperty !== undefined) {
    parts.push(`countedEdgeWhereProperty: ${renderWhereClause(agg.countedEdgeWhereProperty)}`);
  }
  if (agg.countDistinctEndpoint !== undefined) {
    parts.push(`countDistinctEndpoint: ${tsStr(agg.countDistinctEndpoint)}`);
  }
  if (agg.firstMatchOrdinal !== undefined) {
    parts.push(`firstMatchOrdinal: ${renderFirstMatchOrdinal(agg.firstMatchOrdinal)}`);
  } else {
    parts.push(`op: ${tsStr(agg.op)}`);
    parts.push(`threshold: ${agg.threshold}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** Render one `firstMatchOrdinal` RuleFirstMatchOrdinal as an inline TS literal. */
function renderFirstMatchOrdinal(fmo) {
  const broad = Array.isArray(fmo.broadEntryWhere)
    ? `[${fmo.broadEntryWhere.map(renderWhereClause).join(', ')}]`
    : renderWhereClause(fmo.broadEntryWhere);
  return `{ ordinalEdgeProperty: ${tsStr(fmo.ordinalEdgeProperty)}, broadEntryWhere: ${broad} }`;
}

/**
 * Render one `witnessPartition` RuleWitnessPartition as a multi-line TypeScript
 * object literal (the two templates are long, so they get their own lines to
 * match the `interpretation` emit style). Field order is fixed (matching the
 * contract declaration) so the artifact is deterministic regardless of YAML order.
 */
function renderWitnessPartition(wp) {
  const lines = ['{', `      roleEndpoint: ${tsStr(wp.roleEndpoint)},`];
  // `witnessKind` (present only for the non-default `inactive-firer` mode) and
  // `witnessProperty` (present only for `property` mode) are each rendered ONLY
  // when set, so the async `property`-mode rule — which sets `witnessProperty`
  // and omits `witnessKind` — stays byte-identical to the pre-generalization emit.
  if (wp.witnessKind !== undefined) {
    lines.push(`      witnessKind: ${tsStr(wp.witnessKind)},`);
  }
  if (wp.witnessProperty !== undefined) {
    lines.push(`      witnessProperty: ${tsStr(wp.witnessProperty)},`);
  }
  if (wp.witnessArrayProperty !== undefined) {
    lines.push(`      witnessArrayProperty: ${tsStr(wp.witnessArrayProperty)},`);
  }
  if (wp.witnessArrayMember !== undefined) {
    lines.push(`      witnessArrayMember: [${wp.witnessArrayMember.map(tsStr).join(', ')}],`);
  }
  lines.push(`      interpretationWitnessOnly:`);
  lines.push(`        ${tsStr(wp.interpretationWitnessOnly)},`);
  lines.push(`      interpretationMixedWitnessSuffix:`);
  lines.push(`        ${tsStr(wp.interpretationMixedWitnessSuffix)},`);
  lines.push('    }');
  return lines.join('\n');
}

/**
 * Render one `remediation` RuleRemediation (CITED-REMEDIATION) as a multi-line
 * TypeScript object literal. Each ordered step gets its own line (the steps are
 * long, matching the `interpretation` emit style). Field order is fixed (steps,
 * then the optional whatIfTool) so the artifact is deterministic regardless of
 * YAML key order.
 */
function renderRemediation(rem) {
  const lines = ['{'];
  lines.push('      steps: [');
  for (const step of rem.steps) {
    lines.push(`        ${tsStr(step)},`);
  }
  lines.push('      ],');
  if (rem.whatIfTool !== undefined) {
    lines.push(`      whatIfTool: ${tsStr(rem.whatIfTool)},`);
  }
  lines.push('    }');
  return lines.join('\n');
}

/**
 * Render ONE `anyElement` inner clause ({@link ArrayElementClause}) as an inline
 * TS literal. The optional `key` (object-element mode) is emitted first when
 * present, then the single scalar operator (`in` / `notIn` → a scalar array,
 * `neq` / `equals` → a scalar). Exactly one operator is guaranteed by
 * `assertAnyElementClause`.
 */
function renderAnyElementClause(inner) {
  const keyPart = 'key' in inner ? `key: ${tsStr(inner.key)}, ` : '';
  if ('in' in inner) return `{ ${keyPart}in: [${inner.in.map(renderScalar).join(', ')}] }`;
  if ('notIn' in inner) return `{ ${keyPart}notIn: [${inner.notIn.map(renderScalar).join(', ')}] }`;
  if ('neq' in inner) return `{ ${keyPart}neq: ${renderScalar(inner.neq)} }`;
  return `{ ${keyPart}equals: ${renderScalar(inner.equals)} }`;
}

/**
 * Render ONE {@link WhereClause} as an inline TypeScript literal. The
 * scalar-`equals` form emits `{ key: …, equals: … }` byte-identically to the
 * pre-operator codegen (so existing rules regen unchanged); the operator forms
 * emit the single operator key present (`in` / `notIn` → a scalar array, `neq` →
 * a scalar, `anyElement` → a nested {@link ArrayElementClause}). Exactly one
 * operator per clause is guaranteed by `assertWhereClause`.
 */
function renderWhereClause(wp) {
  if ('in' in wp) return `{ key: ${tsStr(wp.key)}, in: [${wp.in.map(renderScalar).join(', ')}] }`;
  if ('notIn' in wp) {
    return `{ key: ${tsStr(wp.key)}, notIn: [${wp.notIn.map(renderScalar).join(', ')}] }`;
  }
  if ('neq' in wp) return `{ key: ${tsStr(wp.key)}, neq: ${renderScalar(wp.neq)} }`;
  // `isNull` renders its boolean operand verbatim (a boolean is emitted as-is by
  // `renderScalar`, but spell it out here for clarity — the operator is boolean-only).
  if ('isNull' in wp) return `{ key: ${tsStr(wp.key)}, isNull: ${wp.isNull} }`;
  if ('isEmpty' in wp) return `{ key: ${tsStr(wp.key)}, isEmpty: ${wp.isEmpty} }`;
  if ('anyElement' in wp) {
    return `{ key: ${tsStr(wp.key)}, anyElement: ${renderAnyElementClause(wp.anyElement)} }`;
  }
  return `{ key: ${tsStr(wp.key)}, equals: ${renderScalar(wp.equals)} }`;
}

/** Render one structural `bind` RulePredicate as an inline TypeScript literal. */
export function renderBind(bind) {
  const parts = [];
  if (bind.edgeType !== undefined) parts.push(`edgeType: ${tsStr(bind.edgeType)}`);
  if (bind.componentTypes !== undefined) {
    parts.push(`componentTypes: [${bind.componentTypes.map(tsStr).join(', ')}]`);
  }
  if (bind.conditionKind !== undefined) parts.push(`conditionKind: ${tsStr(bind.conditionKind)}`);
  if (bind.whereProperty !== undefined) {
    if (Array.isArray(bind.whereProperty)) {
      const els = bind.whereProperty.map(renderWhereClause).join(', ');
      parts.push(`whereProperty: [${els}]`);
    } else {
      parts.push(`whereProperty: ${renderWhereClause(bind.whereProperty)}`);
    }
  }
  if (bind.edgeWhereProperty !== undefined) {
    parts.push(
      `edgeWhereProperty: { key: ${tsStr(bind.edgeWhereProperty.key)}, equals: ${renderScalar(bind.edgeWhereProperty.equals)} }`,
    );
  }
  if (bind.toWhereProperty !== undefined) {
    if (Array.isArray(bind.toWhereProperty)) {
      const els = bind.toWhereProperty.map(renderWhereClause).join(', ');
      parts.push(`toWhereProperty: [${els}]`);
    } else {
      parts.push(`toWhereProperty: ${renderWhereClause(bind.toWhereProperty)}`);
    }
  }
  if (bind.fromWhereProperty !== undefined) {
    if (Array.isArray(bind.fromWhereProperty)) {
      const els = bind.fromWhereProperty.map(renderWhereClause).join(', ');
      parts.push(`fromWhereProperty: [${els}]`);
    } else {
      parts.push(`fromWhereProperty: ${renderWhereClause(bind.fromWhereProperty)}`);
    }
  }
  if (bind.toObjectIn !== undefined) {
    parts.push(`toObjectIn: [${bind.toObjectIn.map(tsStr).join(', ')}]`);
  }
  if (bind.toTypeIn !== undefined) {
    parts.push(`toTypeIn: [${bind.toTypeIn.map(tsStr).join(', ')}]`);
  }
  if (bind.fromTypeIn !== undefined) {
    parts.push(`fromTypeIn: [${bind.fromTypeIn.map(tsStr).join(', ')}]`);
  }
  if (bind.order !== undefined) parts.push(`order: ${bind.order}`);
  if (bind.join !== undefined) parts.push(`join: ${renderJoin(bind.join)}`);
  if (bind.aggregate !== undefined) parts.push(`aggregate: ${renderAggregate(bind.aggregate)}`);
  if (bind.dualEdge !== undefined) parts.push(`dualEdge: ${renderDualEdge(bind.dualEdge)}`);
  if (bind.antiJoin !== undefined) parts.push(`antiJoin: ${renderAntiJoin(bind.antiJoin)}`);
  if (bind.setDifference !== undefined) {
    parts.push(`setDifference: ${renderSetDifference(bind.setDifference)}`);
  }
  if (bind.propertyCompare !== undefined) {
    parts.push(`propertyCompare: ${renderPropertyCompare(bind.propertyCompare)}`);
  }
  if (bind.fieldJoin !== undefined) {
    parts.push(`fieldJoin: ${renderFieldJoin(bind.fieldJoin)}`);
  }
  if (bind.propertyEqualsEndpoint !== undefined) {
    parts.push(`propertyEqualsEndpoint: ${renderPropertyEqualsEndpoint(bind.propertyEqualsEndpoint)}`);
  }
  if (bind.crossObjectCascade !== undefined) {
    parts.push(`crossObjectCascade: ${renderCrossObjectCascade(bind.crossObjectCascade)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `crossObjectCascade` RuleCrossObjectCascade as an inline TypeScript
 * literal. Field order is fixed (matching the contract declaration) so the
 * emitted artifact is deterministic regardless of YAML key order.
 */
function renderCrossObjectCascade(cc) {
  const parts = [
    `writerTriggerEdge: ${tsStr(cc.writerTriggerEdge)}`,
    `writeEdge: ${tsStr(cc.writeEdge)}`,
    `targetIncomingEdgeTypes: [${cc.targetIncomingEdgeTypes.map(tsStr).join(', ')}]`,
  ];
  if (cc.excludeInactive !== undefined) {
    parts.push(`excludeInactive: ${cc.excludeInactive}`);
  }
  if (cc.excludeBeforeSaveFlowWriter !== undefined) {
    parts.push(`excludeBeforeSaveFlowWriter: ${cc.excludeBeforeSaveFlowWriter}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `dualEdge` RuleDualEdge as an inline TypeScript literal.
 */
function renderDualEdge(dual) {
  const parts = [
    `edgeTypeA: ${tsStr(dual.edgeTypeA)}`,
    `edgeTypeB: ${tsStr(dual.edgeTypeB)}`,
    `sameObject: ${dual.sameObject}`,
  ];
  if (dual.excludeInactive !== undefined) {
    parts.push(`excludeInactive: ${dual.excludeInactive}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `antiJoin` RuleAntiJoin as an inline TypeScript literal.
 */
function renderAntiJoin(anti) {
  const parts = [
    `absentEdgeType: ${tsStr(anti.absentEdgeType)}`,
    `correlate: ${tsStr(anti.correlate)}`,
  ];
  if (anti.absentFromTypes !== undefined) {
    parts.push(`absentFromTypes: [${anti.absentFromTypes.map(tsStr).join(', ')}]`);
  }
  if (anti.absentToTypes !== undefined) {
    parts.push(`absentToTypes: [${anti.absentToTypes.map(tsStr).join(', ')}]`);
  }
  if (anti.absentEdgeWhereProperty !== undefined) {
    parts.push(
      `absentEdgeWhereProperty: { key: ${tsStr(anti.absentEdgeWhereProperty.key)}, equals: ${renderScalar(anti.absentEdgeWhereProperty.equals)} }`,
    );
  }
  if (anti.absentFromWhereProperty !== undefined) {
    if (Array.isArray(anti.absentFromWhereProperty)) {
      const els = anti.absentFromWhereProperty.map(renderWhereClause).join(', ');
      parts.push(`absentFromWhereProperty: [${els}]`);
    } else {
      parts.push(`absentFromWhereProperty: ${renderWhereClause(anti.absentFromWhereProperty)}`);
    }
  }
  if (anti.absentToWhereProperty !== undefined) {
    if (Array.isArray(anti.absentToWhereProperty)) {
      const els = anti.absentToWhereProperty.map(renderWhereClause).join(', ');
      parts.push(`absentToWhereProperty: [${els}]`);
    } else {
      parts.push(`absentToWhereProperty: ${renderWhereClause(anti.absentToWhereProperty)}`);
    }
  }
  if (anti.absentFromPhaseIn !== undefined) {
    parts.push(`absentFromPhaseIn: [${anti.absentFromPhaseIn.map(tsStr).join(', ')}]`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `setDifference` RuleSetDifference as an inline TypeScript literal.
 */
function renderSetDifference(sd) {
  const parts = [
    `includeEdgeType: ${tsStr(sd.includeEdgeType)}`,
    `subtractEdgeType: ${tsStr(sd.subtractEdgeType)}`,
  ];
  if (sd.includeToTypes !== undefined) {
    parts.push(`includeToTypes: [${sd.includeToTypes.map(tsStr).join(', ')}]`);
  }
  if (sd.subtractToTypes !== undefined) {
    parts.push(`subtractToTypes: [${sd.subtractToTypes.map(tsStr).join(', ')}]`);
  }
  if (sd.includeEdgeWhereProperty !== undefined) {
    parts.push(
      `includeEdgeWhereProperty: { key: ${tsStr(sd.includeEdgeWhereProperty.key)}, equals: ${renderScalar(sd.includeEdgeWhereProperty.equals)} }`,
    );
  }
  if (sd.subtractEdgeWhereProperty !== undefined) {
    parts.push(
      `subtractEdgeWhereProperty: { key: ${tsStr(sd.subtractEdgeWhereProperty.key)}, equals: ${renderScalar(sd.subtractEdgeWhereProperty.equals)} }`,
    );
  }
  if (sd.requireBothNonEmpty !== undefined) {
    parts.push(`requireBothNonEmpty: ${sd.requireBothNonEmpty}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `propertyCompare` RulePropertyCompare as an inline TypeScript literal.
 */
function renderPropertyCompare(pc) {
  return `{ leftKey: ${tsStr(pc.leftKey)}, rightKey: ${tsStr(pc.rightKey)}, op: ${tsStr(pc.op)}, rankTable: ${tsStr(pc.rankTable)} }`;
}

/**
 * Render one `fieldJoin` RuleFieldJoin as an inline TypeScript literal.
 */
function renderFieldJoin(fj) {
  const parts = [`nameProperty: ${tsStr(fj.nameProperty)}`];
  if (fj.orphanSetDiff !== undefined) {
    const od = fj.orphanSetDiff;
    const odParts = [
      `leftArrayKey: ${tsStr(od.leftArrayKey)}`,
      `leftElementKey: ${tsStr(od.leftElementKey)}`,
      `rightArrayKey: ${tsStr(od.rightArrayKey)}`,
      `rightElementKey: ${tsStr(od.rightElementKey)}`,
    ];
    if (od.rightElementWhere !== undefined) {
      odParts.push(
        `rightElementWhere: { key: ${tsStr(od.rightElementWhere.key)}, equals: ${renderScalar(od.rightElementWhere.equals)} }`,
      );
    }
    parts.push(`orphanSetDiff: { ${odParts.join(', ')} }`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render one `propertyEqualsEndpoint` RulePropertyEqualsEndpoint as an inline
 * TypeScript literal. Field order is fixed (matching the contract declaration)
 * so the emitted artifact is deterministic regardless of YAML key order. The
 * optional `endpointEdgeWhereProperty` renders as a single clause or an array of
 * clauses (via {@link renderWhereClause}) to match the polymorphic contract type.
 */
function renderPropertyEqualsEndpoint(pee) {
  const parts = [
    `nodeProperty: ${tsStr(pee.nodeProperty)}`,
    `endpointEdgeType: ${tsStr(pee.endpointEdgeType)}`,
    `relation: ${tsStr(pee.relation)}`,
  ];
  if (pee.endpointEdgeWhereProperty !== undefined) {
    if (Array.isArray(pee.endpointEdgeWhereProperty)) {
      const els = pee.endpointEdgeWhereProperty.map(renderWhereClause).join(', ');
      parts.push(`endpointEdgeWhereProperty: [${els}]`);
    } else {
      parts.push(`endpointEdgeWhereProperty: ${renderWhereClause(pee.endpointEdgeWhereProperty)}`);
    }
  }
  if (pee.excludeInactive !== undefined) {
    parts.push(`excludeInactive: ${pee.excludeInactive}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render the frozen `CONCEPTS` object literal from the curated concept
 * dictionary. The map key IS the ConceptId; it is re-emitted as `id` so each
 * value is a complete `Concept`. Keys are emitted in YAML document order.
 */
function renderConcepts(concepts) {
  const lines = [];
  lines.push('export const CONCEPTS: Readonly<Record<ConceptId, Concept>> =');
  lines.push('  Object.freeze<Record<ConceptId, Concept>>({');
  for (const id of Object.keys(concepts)) {
    const c = concepts[id];
    lines.push(`    ${tsStr(id)}: {`);
    lines.push(`      id: ${tsStr(id)},`);
    lines.push(`      kind: ${tsStr(c.kind)},`);
    lines.push(`      label: ${tsStr(c.label)},`);
    lines.push(`      summary:`);
    lines.push(`        ${tsStr(c.summary)},`);
    if (c.severity !== undefined) {
      lines.push(`      severity: ${tsStr(c.severity)},`);
    }
    if (c.docs !== undefined) {
      lines.push('      docs: [');
      for (const d of c.docs) {
        lines.push(`        { label: ${tsStr(d.label)}, url: ${tsStr(d.url)} },`);
      }
      lines.push('      ],');
    }
    lines.push('    },');
  }
  lines.push('  });');
  return lines.join('\n');
}

/**
 * Render the frozen `CONCEPT_RULES` array literal from the curated rules. The
 * list order is preserved (significant). Passing the explicit type argument to
 * `Object.freeze` contextually types each literal so its union fields
 * (edgeType / componentType / confidence) narrow instead of widening.
 */
function renderConceptRules(rules) {
  const lines = [];
  lines.push('export const CONCEPT_RULES: readonly ConceptRule[] = Object.freeze<ConceptRule[]>([');
  for (const r of rules) {
    lines.push('  {');
    lines.push(`    id: ${tsStr(r.id)},`);
    lines.push(`    concept: ${tsStr(r.concept)},`);
    lines.push(`    bind: ${renderBind(r.bind)},`);
    lines.push(`    interpretation:`);
    lines.push(`      ${tsStr(r.interpretation)},`);
    if (r.interpretationCrossPhase !== undefined) {
      lines.push(`    interpretationCrossPhase:`);
      lines.push(`      ${tsStr(r.interpretationCrossPhase)},`);
    }
    if (r.witnessPartition !== undefined) {
      lines.push(`    witnessPartition: ${renderWitnessPartition(r.witnessPartition)},`);
    }
    if (r.remediation !== undefined) {
      lines.push(`    remediation: ${renderRemediation(r.remediation)},`);
    }
    lines.push(`    maxConfidence: ${tsStr(r.maxConfidence)},`);
    lines.push(`    absenceShaped: ${r.absenceShaped},`);
    lines.push(`    dependsOnCoverage: [${r.dependsOnCoverage.map(tsStr).join(', ')}],`);
    lines.push('  },');
  }
  lines.push(']);');
  return lines.join('\n');
}

/**
 * Render the deterministic, frozen TypeScript artifact as a string. Shared by
 * the codegen (writes it) and the parity gate (compares against the committed
 * copy) so the two can never drift.
 */
export function generateConceptModelSource() {
  const { modelVersion, statusCodes } = loadConceptModel();
  const edgeSemanticsSection = renderEdgeSemantics(loadEdgeSemantics());
  const conceptsSection = renderConcepts(loadConcepts());
  const conceptRulesSection = renderConceptRules(loadConceptRules());

  const entries = Object.keys(statusCodes)
    .map((code) => {
      const e = statusCodes[code];
      const types = e.producedByTypes.map(tsStr).join(', ');
      return [
        `  ${code}: {`,
        `    category: ${tsStr(e.category)},`,
        `    explanation:`,
        `      ${tsStr(e.explanation)},`,
        `    producedByTypes: [${types}],`,
        `    crossRefObjectAutomation: ${e.crossRefObjectAutomation},`,
        `  },`,
      ].join('\n');
    })
    .join('\n');

  return `/**
 * @generated by packages/mcp/scripts/build-concept-model.mjs — DO NOT EDIT.
 *
 * Concept model — Salesforce status-code taxonomy (RM-0) + safe-to-delete-field
 * edge semantics (RM-1b) + reasoning seed concepts & rules (RM-2).
 * Source of truth (curator-owned): packages/mcp/model/status-taxonomy.yaml
 *                                  packages/mcp/model/edge-semantics.yaml
 *                                  packages/mcp/model/concepts.yaml
 *                                  packages/mcp/model/concept-rules.yaml
 * Model version:                    packages/mcp/model/MODEL_VERSION
 *
 * Regenerate:  pnpm regen:concept-model
 * Parity gate: pnpm check:concept-model
 *
 * \`crossRefObjectAutomation\` marks codes whose most common producer is object
 * automation (trigger / flow), so the handler lists the object's \`triggersOn\`
 * sources as a category-level cross-reference.
 */

import type { Concept, ConceptId, ConceptRule } from '@sf-intelligence/contracts';

/** One status-code taxonomy entry (category-level, never a specific match). */
export interface StatusCodeTaxonomyEntry {
  readonly category: string;
  readonly explanation: string;
  readonly producedByTypes: readonly string[];
  readonly crossRefObjectAutomation: boolean;
}

/** statusCode → category-level explanation. */
export type StatusCodeTaxonomy = Readonly<Record<string, StatusCodeTaxonomyEntry>>;

/** Concept-model version (mirrors packages/mcp/model/MODEL_VERSION). */
export const MODEL_VERSION = ${tsStr(modelVersion)};

export const STATUS_CODE_TAXONOMY: StatusCodeTaxonomy = Object.freeze({
${entries}
});

/** A (category, verdict) classification for one incoming dependency edge. */
export interface EdgeSemanticVerdict {
  readonly category: string;
  readonly verdict: string;
}

/**
 * Per-edge-type rule: a referrer-ComponentType-keyed table plus a \`default\`
 * fallback verdict for source types the table does not list.
 */
export interface EdgeSemanticRule {
  readonly bySourceType: Readonly<Record<string, EdgeSemanticVerdict>>;
  readonly default: EdgeSemanticVerdict;
}

/**
 * The safe-to-delete-field edge-semantics table (RM-1b). Mirrors the tool's
 * \`classifyEdge\` lookup order: the ordered \`bySource\` special cases are checked
 * first (first match wins), then \`byEdgeType[edgeType].bySourceType[sourceType]\`, then that edge
 * type's \`default\`, then the top-level \`default\` for an unknown edge type.
 */
export interface EdgeSemanticSourceRule {
  readonly source: string;
  readonly edgeType: string;
  /** When present, the rule only applies to this referrer ComponentType. */
  readonly fromType?: string;
  readonly category: string;
  readonly verdict: string;
}

export interface EdgeSemantics {
  readonly bySource: readonly EdgeSemanticSourceRule[];
  readonly byEdgeType: Readonly<Record<string, EdgeSemanticRule>>;
  readonly default: EdgeSemanticVerdict;
}

${edgeSemanticsSection}

/**
 * RM-2 reasoning seed concepts — the org-agnostic \`Concept\` dictionary. Each
 * value is a complete \`Concept\` (the map key is re-emitted as \`id\`). Curator-
 * owned; carries NO canonical component ids. Source: packages/mcp/model/concepts.yaml.
 */
${conceptsSection}

/**
 * RM-2 reasoning seed rules — the ordered \`ConceptRule\` list binding each
 * concept to a structural predicate over a grounded slice. Structural (types,
 * edge kinds, property values) only — NO component ids. Source:
 * packages/mcp/model/concept-rules.yaml.
 */
${conceptRulesSection}
`;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = generateConceptModelSource();
  writeFileSync(OUT_PATH, source);
  const codeCount = Object.keys(loadConceptModel().statusCodes).length;
  const edgeTypeCount = Object.keys(loadEdgeSemantics().byEdgeType).length;
  const conceptCount = Object.keys(loadConcepts()).length;
  const ruleCount = loadConceptRules().length;
  console.log(
    `[build-concept-model] wrote ${path.relative(mcpRoot, OUT_PATH)} — ${codeCount} status codes, ${edgeTypeCount} edge types, ${conceptCount} concepts, ${ruleCount} rules (model ${loadConceptModel().modelVersion})`,
  );
}
