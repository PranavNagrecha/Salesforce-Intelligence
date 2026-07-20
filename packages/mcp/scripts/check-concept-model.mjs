#!/usr/bin/env node
/**
 * RM-0 — Concept-model parity gate. Mirrors check-embedding-index.mjs.
 *
 * 1. Regenerates the TypeScript artifact into a string (the SAME codegen the
 *    build uses) and asserts it is BYTE-IDENTICAL to the committed
 *    `src/knowledge/generated/concept-model.ts`. Any drift — a stale generated
 *    file, a hand-edit, or a YAML change committed without a regen — fails with
 *    exit 1.
 * 2. Re-asserts the no-canonical-id invariant over every curated string value.
 *
 * Usage:
 *   node packages/mcp/scripts/check-concept-model.mjs   (from product root)
 *   node scripts/check-concept-model.mjs                 (from packages/mcp)
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  generateConceptModelSource,
  loadConceptModel,
  loadConceptRules,
  loadConcepts,
  loadEdgeSemantics,
  OUT_PATH,
} from './build-concept-model.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(scriptDir, '..');
const rel = (p) => path.relative(mcpRoot, p);

/**
 * A canonical id (`Type:Name`) is a PascalCase ComponentType token, a colon, and
 * an id character — searched ANYWHERE in the string (NOT start-anchored), so an
 * org id embedded mid-prose (in an `interpretation` / `summary` / `explanation`)
 * is caught too, not just one at the very start. Requiring an id character
 * IMMEDIATELY after the colon (no space) keeps lowercase URL schemes (`https:`)
 * and ordinary prose (`Word: text`, `phases, in order, are:`) from matching.
 */
export const CANONICAL_ID_RE = /[A-Z][A-Za-z0-9]+:[A-Za-z0-9_]/;

/** True when a string value contains a canonical-id-like `Type:Name` token. */
export const looksLikeCanonicalId = (value) =>
  typeof value === 'string' && CANONICAL_ID_RE.test(value);

/**
 * Flatten a bind's polymorphic `whereProperty` (a scalar {@link WhereClause}, a
 * NON-EMPTY array of them, or `undefined`) into the `[value, label]` pairs the
 * canonical-id scan must inspect. CRITICAL leak-guard: an ARRAY's `.key` /
 * `.equals` are `undefined`, so the old `whereProperty?.key` / `?.equals`
 * access silently SKIPPED every array element — a hole a canonical id could
 * escape through. Iterating elements here closes it; a scalar is normalized to
 * a one-element array so its scan (and label shape) is uniform.
 *
 * Every clause contributes its `key` PLUS its OPERATOR OPERAND(S): the
 * scalar `equals` / `neq` value, or EACH member of an `in` / `notIn` array — so a
 * canonical id can hide in NEITHER a bare equals NOR an operator operand. The
 * `isNull` operand is a boolean, which can never be a canonical id, so it
 * contributes only its `key` (no operand pair). The `anyElement` operand is a
 * NESTED clause (`{ key?, <inner op> }`) — its OWN inner `key` and inner operand(s)
 * are scanned too, so a canonical id can't hide inside the existential's inner
 * comparison either. Exactly one operator key is present per clause (guaranteed by
 * `assertWhereClause`).
 */
export const whereMappingPairs = (whereProperty, label) =>
  (Array.isArray(whereProperty)
    ? whereProperty
    : whereProperty
      ? [whereProperty]
      : []
  ).flatMap((wp, i) => {
    const at = `${label}[${i}]`;
    const pairs = [[wp.key, `${at}.key`]];
    if (Array.isArray(wp.in)) {
      wp.in.forEach((v, j) => pairs.push([v, `${at}.in[${j}]`]));
    } else if (Array.isArray(wp.notIn)) {
      wp.notIn.forEach((v, j) => pairs.push([v, `${at}.notIn[${j}]`]));
    } else if (wp.neq !== undefined) {
      pairs.push([wp.neq, `${at}.neq`]);
    } else if (wp.isNull !== undefined) {
      // Boolean operand — nothing to scan (scan the `key` only, already pushed).
    } else if (wp.anyElement !== undefined && wp.anyElement !== null) {
      // Existential array-element matcher: scan the inner clause's OWN key +
      // operand(s) so a canonical id can't escape through the nested comparison.
      const inner = wp.anyElement;
      const innerAt = `${at}.anyElement`;
      if (inner.key !== undefined) pairs.push([inner.key, `${innerAt}.key`]);
      if (Array.isArray(inner.in)) {
        inner.in.forEach((v, j) => pairs.push([v, `${innerAt}.in[${j}]`]));
      } else if (Array.isArray(inner.notIn)) {
        inner.notIn.forEach((v, j) => pairs.push([v, `${innerAt}.notIn[${j}]`]));
      } else if (inner.neq !== undefined) {
        pairs.push([inner.neq, `${innerAt}.neq`]);
      } else if (inner.equals !== undefined) {
        pairs.push([inner.equals, `${innerAt}.equals`]);
      }
    } else {
      pairs.push([wp.equals, `${at}.equals`]);
    }
    return pairs;
  });

/**
 * Run the parity + no-canonical-id gate. Exits the process with status 1 on any
 * failure, or logs PASS and returns on success. Wrapped in a function (invoked
 * only from the CLI entry below) so importing this module for tests has no side
 * effects — the regex + predicate above can be unit-tested without running the
 * gate or calling `process.exit`.
 */
function main() {
  let failed = false;

  // ── 1. Parity: committed artifact vs freshly generated ──────────────────────
  if (!existsSync(OUT_PATH)) {
    console.error(`[check-concept-model] FAIL: generated artifact not found at ${rel(OUT_PATH)}`);
    process.exit(1);
  }

  let regenerated;
  try {
    regenerated = generateConceptModelSource();
  } catch (e) {
    console.error(`[check-concept-model] FAIL: codegen threw: ${e.message}`);
    process.exit(1);
  }

  const committed = readFileSync(OUT_PATH, 'utf8');
  if (committed !== regenerated) {
    const cLines = committed.split('\n');
    const rLines = regenerated.split('\n');
    let firstDiff = -1;
    for (let i = 0; i < Math.max(cLines.length, rLines.length); i++) {
      if (cLines[i] !== rLines[i]) {
        firstDiff = i;
        break;
      }
    }
    console.error(
      `[check-concept-model] FAIL: committed ${rel(OUT_PATH)} is STALE (drift from the model).`,
    );
    if (firstDiff >= 0) {
      console.error(`  first difference at line ${firstDiff + 1}:`);
      console.error(`    committed:    ${JSON.stringify(cLines[firstDiff] ?? '<eof>')}`);
      console.error(`    regenerated:  ${JSON.stringify(rLines[firstDiff] ?? '<eof>')}`);
    }
    failed = true;
  } else {
    console.log(
      `[check-concept-model] OK — ${rel(OUT_PATH)} is byte-identical to the model (${regenerated.length} bytes)`,
    );
  }

  // ── 2. Re-assert the no-canonical-id invariant ──────────────────────────────
  let statusCodes;
  let edgeSemantics;
  let concepts;
  let conceptRules;
  try {
    ({ statusCodes } = loadConceptModel());
    edgeSemantics = loadEdgeSemantics();
    concepts = loadConcepts();
    conceptRules = loadConceptRules();
  } catch (e) {
    console.error(`[check-concept-model] FAIL: model failed structural validation: ${e.message}`);
    process.exit(1);
  }

  const offenders = [];
  for (const [code, entry] of Object.entries(statusCodes)) {
    for (const value of [code, entry.category, entry.explanation, ...entry.producedByTypes]) {
      if (looksLikeCanonicalId(value)) {
        offenders.push(`${code}: ${JSON.stringify(value)}`);
      }
    }
  }
  // Edge-semantics: every key and every {category, verdict} value must be org-agnostic.
  const checkEdgeValue = (value, where) => {
    if (looksLikeCanonicalId(value)) {
      offenders.push(`${where}: ${JSON.stringify(value)}`);
    }
  };
  {
    const ft = edgeSemantics.formulaTokenizer;
    for (const k of ['edgeType', 'source', 'category', 'verdict']) {
      checkEdgeValue(ft[k], `edgeSemantics.formulaTokenizer.${k}`);
    }
    for (const [edgeType, rule] of Object.entries(edgeSemantics.byEdgeType)) {
      checkEdgeValue(edgeType, `edgeSemantics.byEdgeType.${edgeType} (key)`);
      for (const [sourceType, pair] of Object.entries(rule.bySourceType)) {
        checkEdgeValue(sourceType, `edgeSemantics.byEdgeType.${edgeType}.bySourceType.${sourceType} (key)`);
        checkEdgeValue(pair.category, `edgeSemantics.byEdgeType.${edgeType}.bySourceType.${sourceType}.category`);
        checkEdgeValue(pair.verdict, `edgeSemantics.byEdgeType.${edgeType}.bySourceType.${sourceType}.verdict`);
      }
      checkEdgeValue(rule.default.category, `edgeSemantics.byEdgeType.${edgeType}.default.category`);
      checkEdgeValue(rule.default.verdict, `edgeSemantics.byEdgeType.${edgeType}.default.verdict`);
    }
    checkEdgeValue(edgeSemantics.default.category, 'edgeSemantics.default.category');
    checkEdgeValue(edgeSemantics.default.verdict, 'edgeSemantics.default.verdict');
  }
  // RM-2 concepts: every id key and every curated string must be org-agnostic.
  for (const [id, concept] of Object.entries(concepts)) {
    for (const [value, where] of [
      [id, `concepts.${id} (key)`],
      [concept.kind, `concepts.${id}.kind`],
      [concept.label, `concepts.${id}.label`],
      [concept.summary, `concepts.${id}.summary`],
    ]) {
      if (looksLikeCanonicalId(value)) offenders.push(`${where}: ${JSON.stringify(value)}`);
    }
    for (const [i, doc] of (concept.docs ?? []).entries()) {
      for (const k of ['label', 'url']) {
        if (looksLikeCanonicalId(doc[k])) {
          offenders.push(`concepts.${id}.docs[${i}].${k}: ${JSON.stringify(doc[k])}`);
        }
      }
    }
  }
  // RM-2 concept rules: id, concept, interpretation, every bind field, and
  // dependsOnCoverage entries must all be org-agnostic (no canonical ids).
  conceptRules.forEach((rule, idx) => {
    const w = `conceptRules[${idx}]`;
    const flat = [
      [rule.id, `${w}.id`],
      [rule.concept, `${w}.concept`],
      [rule.interpretation, `${w}.interpretation`],
      // Optional RM-loop PASS 2 upgraded JOIN template — scanned too (undefined
      // when absent; looksLikeCanonicalId ignores non-strings) so an org id can
      // never sneak into the cross-phase claim wording.
      [rule.interpretationCrossPhase, `${w}.interpretationCrossPhase`],
      [rule.bind.edgeType, `${w}.bind.edgeType`],
      [rule.bind.conditionKind, `${w}.bind.conditionKind`],
      // Polymorphic whereProperty (scalar | AND-array): iterate every element so
      // a canonical id inside an array element cannot escape the guard.
      ...whereMappingPairs(rule.bind.whereProperty, `${w}.bind.whereProperty`),
      [rule.bind.edgeWhereProperty?.key, `${w}.bind.edgeWhereProperty.key`],
      [rule.bind.edgeWhereProperty?.equals, `${w}.bind.edgeWhereProperty.equals`],
      ...(rule.bind.componentTypes ?? []).map((t, i) => [t, `${w}.bind.componentTypes[${i}]`]),
      // RM-loop JOIN sub-predicate string values (all org-agnostic by contract).
      [rule.bind.join?.throughType, `${w}.bind.join.throughType`],
      [rule.bind.join?.throughKeyArray, `${w}.bind.join.throughKeyArray`],
      [rule.bind.join?.writeEdgeType, `${w}.bind.join.writeEdgeType`],
      ...(rule.bind.join?.throughConditionKinds ?? []).map((k, i) => [k, `${w}.bind.join.throughConditionKinds[${i}]`]),
      ...(rule.bind.join?.writerTypes ?? []).map((t, i) => [t, `${w}.bind.join.writerTypes[${i}]`]),
      // RM-loop AGGREGATE sub-predicate string values (all org-agnostic by contract).
      [rule.bind.aggregate?.groupByEdgeProperty, `${w}.bind.aggregate.groupByEdgeProperty`],
      [rule.bind.aggregate?.edgeSource, `${w}.bind.aggregate.edgeSource`],
      // Full where-clause scan (key + EVERY operator operand: equals / neq / in /
      // notIn / anyElement / isNull) — previously only .key/.equals were scanned, so
      // an org id in an in/notIn operand escaped the guard (RM-review F17).
      ...whereMappingPairs(rule.bind.aggregate?.endpointWhereProperty, `${w}.bind.aggregate.endpointWhereProperty`),
      ...whereMappingPairs(rule.bind.aggregate?.countedEdgeWhereProperty, `${w}.bind.aggregate.countedEdgeWhereProperty`),
      [rule.bind.aggregate?.countDistinctEndpoint, `${w}.bind.aggregate.countDistinctEndpoint`],
      [rule.bind.aggregate?.eventSplitByProperty, `${w}.bind.aggregate.eventSplitByProperty`],
      // D9 propertyEqualsEndpoint sub-predicate string values (org-agnostic by
      // contract): the compared node property, the endpoint edge type, and every
      // operand of the optional endpoint-edge where filter (scalar | AND-array).
      [rule.bind.propertyEqualsEndpoint?.nodeProperty, `${w}.bind.propertyEqualsEndpoint.nodeProperty`],
      [rule.bind.propertyEqualsEndpoint?.endpointEdgeType, `${w}.bind.propertyEqualsEndpoint.endpointEdgeType`],
      ...whereMappingPairs(
        rule.bind.propertyEqualsEndpoint?.endpointEdgeWhereProperty,
        `${w}.bind.propertyEqualsEndpoint.endpointEdgeWhereProperty`,
      ),
      // EC-11 / D3 crossObjectCascade sub-predicate edge-type strings (org-agnostic by contract).
      [rule.bind.crossObjectCascade?.writerTriggerEdge, `${w}.bind.crossObjectCascade.writerTriggerEdge`],
      [rule.bind.crossObjectCascade?.writeEdge, `${w}.bind.crossObjectCascade.writeEdge`],
      ...(rule.bind.crossObjectCascade?.targetIncomingEdgeTypes ?? []).map((t, i) => [
        t,
        `${w}.bind.crossObjectCascade.targetIncomingEdgeTypes[${i}]`,
      ]),
      // EC-4 / EC-16 endpoint-node predicates — previously unscanned (RM-review F17).
      ...whereMappingPairs(rule.bind.toWhereProperty, `${w}.bind.toWhereProperty`),
      ...whereMappingPairs(rule.bind.fromWhereProperty, `${w}.bind.fromWhereProperty`),
      ...(rule.bind.toObjectIn ?? []).map((t, i) => [t, `${w}.bind.toObjectIn[${i}]`]),
      ...(rule.bind.toTypeIn ?? []).map((t, i) => [t, `${w}.bind.toTypeIn[${i}]`]),
      ...(rule.bind.fromTypeIn ?? []).map((t, i) => [t, `${w}.bind.fromTypeIn[${i}]`]),
      // witnessPartition — its interpretation templates are FREE-PROSE emitted
      // VERBATIM into user-facing claims, so a canonical id here would ship to a
      // caller with a green gate. Previously unscanned ENTIRELY (RM-review F17); the
      // builder's own check on these is START-anchored and cannot see a mid-prose id.
      [rule.witnessPartition?.roleEndpoint, `${w}.witnessPartition.roleEndpoint`],
      [rule.witnessPartition?.witnessKind, `${w}.witnessPartition.witnessKind`],
      [rule.witnessPartition?.witnessProperty, `${w}.witnessPartition.witnessProperty`],
      [rule.witnessPartition?.witnessArrayProperty, `${w}.witnessPartition.witnessArrayProperty`],
      [rule.witnessPartition?.witnessArrayMember, `${w}.witnessPartition.witnessArrayMember`],
      [rule.witnessPartition?.interpretationWitnessOnly, `${w}.witnessPartition.interpretationWitnessOnly`],
      [rule.witnessPartition?.interpretationMixedWitnessSuffix, `${w}.witnessPartition.interpretationMixedWitnessSuffix`],
      ...rule.dependsOnCoverage.map((t, i) => [t, `${w}.dependsOnCoverage[${i}]`]),
    ];
    for (const [value, where] of flat) {
      if (looksLikeCanonicalId(value)) offenders.push(`${where}: ${JSON.stringify(value)}`);
    }
  });
  if (offenders.length > 0) {
    console.error(`[check-concept-model] FAIL: canonical-id-like string value(s) found:`);
    for (const o of offenders) console.error(`    ${o}`);
    failed = true;
  } else {
    console.log('[check-concept-model] OK — no canonical-id strings in the concept model');
  }

  if (failed) {
    console.error('\n[check-concept-model] FAIL — regenerate the artifact:\n  pnpm regen:concept-model');
    process.exit(1);
  }

  console.log('[check-concept-model] PASS — concept model in parity');
}

// ── CLI entry ───────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
