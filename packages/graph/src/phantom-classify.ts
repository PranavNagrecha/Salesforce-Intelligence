/**
 * The phantom taxonomy classifier — pure logic shared by the MCP layer
 * (`reference_stub` on get_component) and the CLI (`sfi refresh --components`
 * demand-retrieve gate). Both packages depend on `@sf-intelligence/graph`, so
 * the classification lives here rather than being duplicated.
 *
 * A referenced-but-unretrieved id (an edge target with no node) is classified
 * into one of eight mutually-exclusive buckets — the taxonomy measured in
 * `docs/reports/phantom-taxonomy-audit.md` (GATE 0) — from its id shape, its
 * inbound edge kinds, and the manifest coverage of its ComponentType.
 */

import type { ComponentId, PhantomClassification } from '@sf-intelligence/contracts';

/** Coverage of a ComponentType in the manifest: covered / partial / not-modeled / absent. */
export type CoverageStatus = 'covered' | 'partial' | 'notModeled' | 'absent';

/**
 * The Change Data Capture (CDC) stream-entity name suffix. A CDC entity is
 * `{StandardObject}ChangeEvent` (`AccountChangeEvent`) or
 * `{CustomObjectWithout__c}__ChangeEvent` (`Order__ChangeEvent`); both end in
 * this literal, and neither carries a `__c` / `__e` object suffix.
 */
const CHANGE_EVENT_SUFFIX = 'ChangeEvent';

/**
 * True when `apiName` names a Change Data Capture stream entity
 * (`AccountChangeEvent`, `Order__ChangeEvent`, `ns__Widget__ChangeEvent`).
 *
 * Single source of truth for the CDC name-pattern rule: the MCP CDC tools, the
 * phantom classifier, and the refresh's auto-expansion gate all read it, so
 * "is this a Change Event?" cannot drift between the surface that reports one
 * and the surface that tries to retrieve one.
 */
export const isChangeEventApiName = (apiName: string): boolean =>
  apiName.length > CHANGE_EVENT_SUFFIX.length &&
  apiName.endsWith(CHANGE_EVENT_SUFFIX);

/**
 * True when `id` is a `CustomObject:` id naming a Change Data Capture stream
 * entity.
 *
 * STRUCTURAL, NOT A COVERAGE GAP. A ChangeEvent is synthesised by the platform
 * from its parent object's CDC configuration; the Metadata API emits no
 * `objects/AccountChangeEvent/` folder on ANY org, so no retrieve manifest —
 * however wide — can ever produce the node. Classifying such a dangling target
 * as a missing CustomObject hands the caller a remedy (`sfi refresh`) that can
 * never work, and makes the refresh re-request the same entity on every run,
 * forever (the phantom never converges). {@link classifyPhantom} therefore
 * short-circuits on this shape ahead of every coverage-driven bucket.
 */
export const isChangeEventEntityId = (id: ComponentId): boolean => {
  if (!id.startsWith('CustomObject:')) return false;
  return isChangeEventApiName(id.slice('CustomObject:'.length));
};

/** The custom-object form of the CDC suffix (`Order__c` -> `Order__ChangeEvent`). */
const CUSTOM_CHANGE_EVENT_SUFFIX = `__${CHANGE_EVENT_SUFFIX}`;

/**
 * The sObject apiName a Change Event stream belongs to — the exact inverse of
 * the CDC naming rule, so a caller handed an unretrievable ChangeEvent can be
 * pointed at the component that IS in the vault.
 *
 * `AccountChangeEvent` -> `Account` (standard: the suffix is simply dropped).
 * `Order__ChangeEvent` -> `Order__c` (custom: the `__c` the CDC name dropped is
 * restored). Returns `null` when `apiName` is not a Change Event name, or when
 * stripping the suffix would leave nothing to name.
 */
export const changeEventParentApiName = (apiName: string): string | null => {
  if (!isChangeEventApiName(apiName)) return null;
  if (apiName.endsWith(CUSTOM_CHANGE_EVENT_SUFFIX)) {
    const base = apiName.slice(0, -CUSTOM_CHANGE_EVENT_SUFFIX.length);
    return base.length === 0 ? null : `${base}__c`;
  }
  const base = apiName.slice(0, -CHANGE_EVENT_SUFFIX.length);
  return base.length === 0 ? null : base;
};

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
 * Classify a phantom id by precedence: change-event-stream → blindspot-manifest
 * → managed-extension → standard-field-phantom → grant-only →
 * automation-critical → unknown.
 *
 * `change-event-stream` leads because it is the one bucket whose remedy is
 * NEVER "retrieve it" — see {@link isChangeEventEntityId}. Every other bucket
 * below it is decided from coverage or edge shape, and each of their remedies
 * (widen the manifest, demand-retrieve, treat as external) would be a fix-it
 * the product cannot deliver for a CDC entity.
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
  if (isChangeEventEntityId(id)) return 'change-event-stream';
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
