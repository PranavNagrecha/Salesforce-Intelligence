/**
 * ONE per-component-type REFERRER COVERAGE table (A04 / A05 / C02 / C07).
 *
 * `get_impact`, `find_component_usages` and `what_if_change_method_signature`
 * answered "who references X?" and reported `complete: true` / no blind spots
 * for types whose referrers are only partly modeled as graph edges: a custom
 * label used in formula fields, an Apex method called from an Aura controller's
 * JavaScript, a class instantiated by `Type.forName`. The only structural
 * blind-spot list (`UNWALKED_REFERRER_CLASSES`) covered CustomField and
 * CustomObject.
 *
 * This table is the single source for "which referrer kinds of this type does
 * the graph model, and how well". A result may claim completeness only when
 * every APPLICABLE kind for the root type is tier `edge`. Consumers derive their
 * blind spots from {@link unmodeledReferrerKinds}; nothing restates the list.
 *
 * Tiers:
 *   - `edge`              — modeled as incoming graph edges.
 *   - `edge-class-level`  — modeled, but only at class granularity (the edge
 *                           says "this bundle uses the class", not which method).
 *   - `grep`              — not an edge; only `find_component_usages`' text
 *                           supplement can surface it.
 *   - `none`              — not modeled at all.
 *
 * Keep entries org-agnostic. Add a row when an extractor starts (or stops)
 * emitting a referrer kind; a kind newer builders emit carries `since` (from
 * `EDGE_FAMILIES_BY_VERSION`) so an older vault is judged by its own builder.
 */
import type { ComponentType, Node } from '@sf-intelligence/contracts';
import { compareVersions } from '@sf-intelligence/core';

import { edgeFamilySince } from './vault-freshness.js';

/** How well a referrer kind is modeled. */
export type ReferrerTier = 'edge' | 'edge-class-level' | 'grep' | 'none';

/** One referrer kind for a root component type. */
export interface ReferrerKind {
  /** Human name of the referrer kind (stable; surfaced verbatim). */
  readonly kind: string;
  readonly tier: ReferrerTier;
  /**
   * When present, the kind applies only to roots for which this returns true
   * (e.g. Aura method callers only matter for a class with `@AuraEnabled`
   * methods). Without the root node a conditional kind does not apply.
   */
  readonly appliesTo?: (root: Node) => boolean;
  /**
   * `true` for a blind spot that applies to EVERY component of the type and is
   * already part of each tool's standing disclosure (e.g. reflection). It still
   * makes completeness `partial`, but does not by itself move a `safe` verdict.
   */
  readonly generic?: boolean;
  /**
   * When the edge is emitted only by builders from release `version` on (read
   * from `EDGE_FAMILIES_BY_VERSION`, never restated): a vault built before it
   * holds the kind only at `olderTier`.
   */
  readonly since?: { readonly version: string; readonly olderTier: ReferrerTier };
}

/**
 * The tier `k` has on a vault built by `builtBy`. An unknown or unparseable
 * builder version keeps the current tier (a verdict is never moved on a guess;
 * the vault-freshness assessment discloses an undetectable drift separately).
 */
const tierFor = (k: ReferrerKind, builtBy: string | null | undefined): ReferrerTier =>
  k.since !== undefined &&
  typeof builtBy === 'string' &&
  builtBy !== '' &&
  compareVersions(builtBy, k.since.version)
    ? k.since.olderTier
    : k.tier;

const prop = (root: Node, key: string): unknown =>
  (root.properties as Record<string, unknown>)[key];

/**
 * The field/object referrer classes that were the original structural blind
 * spots (D3-soundness-overclaim). Named verbatim — `soundness.ts` re-exports
 * them as `UNWALKED_REFERRER_CLASSES`.
 */
const FIELD_OBJECT_UNWALKED: readonly ReferrerKind[] = [
  { kind: 'roll-up source coupling', tier: 'none' },
  { kind: 'layout placement', tier: 'none' },
  { kind: 'flow decision/filter reads', tier: 'none' },
  { kind: 'tab/app membership', tier: 'none' },
];

const APEX_CLASS_KINDS: readonly ReferrerKind[] = [
  { kind: 'Apex class / trigger callers', tier: 'edge' },
  { kind: 'LWC Apex imports', tier: 'edge' },
  { kind: 'Visualforce controllers / extensions', tier: 'edge' },
  { kind: 'Flow invocable actions', tier: 'edge' },
  { kind: 'OmniStudio remote actions', tier: 'edge' },
  // Aura `component.get('c.<method>')` in a bundle that declares
  // `controller="<Class>"` is a method-level (heuristic) callsApex edge. A
  // bundle WITHOUT a declared controller cannot be resolved to a class and is
  // only disclosed on its own node (`unresolvedServerActions`), never an edge.
  {
    kind: 'Aura controller JS method calls (c.<method>)',
    tier: 'edge',
    // Aura can call only @AuraEnabled methods.
    appliesTo: (root) => prop(root, 'hasAuraEnabledMethod') === true,
    since: {
      version: edgeFamilySince('method-level LWC/Aura -> Apex caller edges'),
      olderTier: 'edge-class-level',
    },
  },
  {
    kind: 'Aura server actions in bundles with no declared controller',
    tier: 'none',
    appliesTo: (root) => prop(root, 'hasAuraEnabledMethod') === true,
  },
  {
    kind: 'dynamic instantiation (Type.forName / Callable / reflection)',
    tier: 'none',
    generic: true,
  },
  {
    kind: 'external API callers (REST / SOAP / Aura-enabled from outside the org)',
    tier: 'none',
    appliesTo: (root) =>
      prop(root, 'isRestResource') === true || prop(root, 'hasAuraEnabledMethod') === true,
  },
];

const CUSTOM_LABEL_KINDS: readonly ReferrerKind[] = [
  {
    kind: 'Apex System.Label references',
    tier: 'edge',
    since: { version: edgeFamilySince('Apex Custom Label reference edges'), olderTier: 'grep' },
  },
  { kind: 'Flow label references', tier: 'edge' },
  { kind: 'LWC @salesforce/label imports', tier: 'edge' },
  { kind: 'Aura $Label references', tier: 'edge' },
  // find_component_usages' accessor-anchored grep reads these; no edge exists.
  { kind: 'formula fields / validation rules ($Label)', tier: 'grep' },
  { kind: 'Visualforce $Label references', tier: 'edge' },
  { kind: 'email templates / custom metadata text', tier: 'none' },
];

/** The table. Types absent from it make no structural blind-spot claim. */
export const REFERRER_COVERAGE: Readonly<Partial<Record<ComponentType, readonly ReferrerKind[]>>> = {
  CustomField: FIELD_OBJECT_UNWALKED,
  CustomObject: FIELD_OBJECT_UNWALKED,
  ApexClass: APEX_CLASS_KINDS,
  CustomLabel: CUSTOM_LABEL_KINDS,
};

/** Referrer kinds of `rootType` that apply to `root` (all kinds when `root` is unknown). */
export const applicableReferrerKinds = (
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): readonly ReferrerKind[] => {
  if (rootType === null) return [];
  const kinds = REFERRER_COVERAGE[rootType] ?? [];
  // A conditional kind applies only when the root node is known and matches —
  // its predicate reads the root's own extracted properties. The tier is the
  // one THIS vault's builder could produce (`builtBy` = `manifest.version`).
  return kinds
    .filter((k) => k.appliesTo === undefined || (root != null && k.appliesTo(root)))
    .map((k) => {
      const tier = tierFor(k, builtBy);
      return tier === k.tier ? k : { ...k, tier };
    });
};

/**
 * The applicable referrer kinds an EDGE WALK cannot fully see (any tier but
 * `edge`), formatted `"<kind>"` for `none`/`grep` and `"<kind> (class-level only)"`
 * for `edge-class-level`. Empty means the walk may claim completeness.
 */
export const unmodeledReferrerKinds = (
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): readonly string[] =>
  applicableReferrerKinds(rootType, root, builtBy)
    .filter((k) => k.tier !== 'edge')
    .map((k) => (k.tier === 'edge-class-level' ? `${k.kind} (class-level only)` : k.kind));

/**
 * The applicable kinds NO tool searches (tier `none`) — the ones even
 * `find_component_usages`' text supplement cannot answer.
 */
export const unsearchedReferrerKinds = (
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): readonly string[] =>
  applicableReferrerKinds(rootType, root, builtBy)
    .filter((k) => k.tier === 'none')
    .map((k) => k.kind);

/**
 * The subset of {@link unmodeledReferrerKinds} that is specific to this root
 * (not `generic`): when non-empty, an absence-based `safe` cannot stand.
 */
export const verdictHedgingReferrerKinds = (
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): readonly string[] =>
  applicableReferrerKinds(rootType, root, builtBy)
    .filter((k) => k.tier !== 'edge' && k.generic !== true)
    .map((k) => (k.tier === 'edge-class-level' ? `${k.kind} (class-level only)` : k.kind));

/** The component type named by a canonical id prefix, or `null` when absent. */
export const rootTypeFromId = (id: string): ComponentType | null => {
  const i = id.indexOf(':');
  return i > 0 ? (id.slice(0, i) as ComponentType) : null;
};
