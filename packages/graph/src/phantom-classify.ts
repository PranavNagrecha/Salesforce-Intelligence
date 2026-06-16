/**
 * The phantom taxonomy classifier — pure logic shared by the MCP layer
 * (`reference_stub` on get_component) and the CLI (`sfi refresh --components`
 * demand-retrieve gate). Both packages depend on `@sf-intelligence/graph`, so
 * the classification lives here rather than being duplicated.
 *
 * A referenced-but-unretrieved id (an edge target with no node) is classified
 * into one of six mutually-exclusive buckets — the taxonomy measured in
 * `docs/reports/phantom-taxonomy-audit.md` (GATE 0) — from its id shape, its
 * inbound edge kinds, and the manifest coverage of its ComponentType.
 */

import type { ComponentId, PhantomClassification } from '@sf-intelligence/contracts';

/** Coverage of a ComponentType in the manifest: covered / partial / not-modeled / absent. */
export type CoverageStatus = 'covered' | 'partial' | 'notModeled' | 'absent';

/**
 * Edge kinds that are NOT functional references: permission grants and layout
 * decoration. A *functional* reference is any other kind — automation, code, or
 * config that actually depends on the target.
 */
const NON_FUNCTIONAL_EDGE_KINDS = new Set<string>(['grantedBy', 'usedInLayout']);

/** The managed namespace prefix of an id's object part, or `undefined` (`ns__Object__c` → "ns"). */
export const managedNamespaceOf = (id: ComponentId): string | undefined => {
  const apiName = id.slice(id.indexOf(':') + 1);
  const objectPart = apiName.split('.')[0] ?? '';
  const segs = objectPart.split('__');
  return segs.length >= 3 ? segs[0] : undefined;
};

/**
 * Classify a phantom id by precedence: blindspot-manifest → managed-extension →
 * standard-field-phantom → grant-only → automation-critical → unknown.
 *
 * `nonHeuristicEdgeKinds` is the subset of `edgeKinds` present at declared /
 * parsed (non-heuristic) confidence; automation-critical requires a non-heuristic
 * FUNCTIONAL reference, matching the GATE-0 report's definition so counts align.
 */
export const classifyPhantom = (
  id: ComponentId,
  edgeKinds: readonly string[],
  nonHeuristicEdgeKinds: readonly string[],
  coverageStatus: CoverageStatus,
): PhantomClassification => {
  if (coverageStatus === 'notModeled' || coverageStatus === 'absent') {
    return 'blindspot-manifest';
  }
  const apiName = id.slice(id.indexOf(':') + 1);
  const objectPart = apiName.split('.')[0] ?? '';
  const segs = objectPart.split('__');
  if (segs.length >= 3) return 'managed-extension';
  // `standard-field-phantom` means "a standard object or a field on one" — a
  // SCHEMA classification, so it only applies to CustomObject / CustomField ids.
  // Without this type guard, a no-`__` object part on ANY type was mislabeled a
  // standard field with a "treat it as standard" remedy — e.g. `ApexClass:newMap`
  // (a `Trigger.newMap` parse artifact), or a phantom Flow / RecordType. Those
  // fall through to the functional-reference buckets (automation-critical /
  // unknown), which carry an honest remedy.
  const componentType = id.slice(0, id.indexOf(':'));
  const isSchemaId = componentType === 'CustomField' || componentType === 'CustomObject';
  // P14-PHANTOM-edges: a standard object is ALWAYS PascalCase — a lowercase
  // no-`__` object part (`CustomField:app.Id`, `CustomField:acc.Status__c`)
  // is an un-type-resolved Apex local variable from the heuristic scanner,
  // not a standard field. Mislabeling it standard-field-phantom shipped a
  // "treat it as standard" remedy for a parse artifact; let it fall through
  // to the functional buckets (its honest classification is `unknown`).
  const startsUppercase = /^[A-Z]/.test(objectPart);
  if (isSchemaId && segs.length === 1 && startsUppercase) return 'standard-field-phantom';
  if (edgeKinds.length > 0 && edgeKinds.every((k) => k === 'grantedBy')) {
    return 'grant-only';
  }
  if (nonHeuristicEdgeKinds.some((k) => !NON_FUNCTIONAL_EDGE_KINDS.has(k))) {
    return 'automation-critical';
  }
  return 'unknown';
};
