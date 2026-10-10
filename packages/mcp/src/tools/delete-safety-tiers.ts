/**
 * Field-delete TIERING on top of the curated per-edge classification
 * (`classifyEdgeSemantics`). The concept-model table keys on edge type and
 * referrer type only; two facts it cannot see decide the honest tier:
 *
 *   1. HOW the reference was found. A parsed Apex reference (AST: dot-access,
 *      static SOQL) is a compile-time dependency — Salesforce refuses the
 *      delete — while a regex-only match may be a false positive. A field
 *      named only in a SOQL string literal (`mechanism: soql-string-literal`)
 *      is parsed but NOT compiler-checked, so it stays `risky`. The same
 *      split holds for an LWC `@salesforce/schema` import vs an in-body match.
 *      Both used to be `risky`, while an Obsolete Flow was `blocking`: the
 *      tiers were reversed for the one case the platform actually enforces.
 *   2. WHETHER the referrer runs. A string reference from an INACTIVE
 *      OmniStudio component or DLRS definition breaks nothing today (the
 *      platform does not refuse the delete), so it is `review`. A DataMapper's
 *      run state comes from its callers, not its own flag (see
 *      {@link omniCallerContext}). A Flow or
 *      validation rule keeps its tier — Salesforce refuses the delete for an
 *      inactive version too — but carries its `status` so the reader is told
 *      it does not run.
 */

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import { getNodeById, listEdges, type GraphStore } from '@sf-intelligence/graph';

/** The referrer's declared run state, when the vault records one. */
export interface ReferrerRunState {
  /** `false` = recorded as not running; `null` = not recorded. */
  readonly active: boolean | null;
  readonly status?: string;
}

const boolProp = (v: unknown): boolean | null =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;

/**
 * Read the run state from the referrer node (Flow `status`; `active` /
 * `isActive` booleans) or, for a DLRS rollup definition, from the edge (the
 * record node is a generic CustomMetadataRecord; the extractor stamps `active`
 * on the edge).
 */
export const referrerRunState = (edge: Edge, fromNode: Node): ReferrerRunState => {
  if (edge.source === 'dlrs-rollup') {
    const active = boolProp(edge.properties['active']);
    return active === null ? { active } : { active, status: active ? 'Active' : 'Inactive' };
  }
  return ownRunState(fromNode);
};

/** A node's own declared run state (Flow `status`; `active` / `isActive`). */
const ownRunState = (node: Node): ReferrerRunState => {
  const props = node.properties;
  const status = props['status'];
  if (typeof status === 'string' && status.length > 0) {
    return { active: status === 'Active', status };
  }
  const active = boolProp(props['active']) ?? boolProp(props['isActive']);
  if (active === null) return { active: null };
  return { active, status: active ? 'Active' : 'Inactive' };
};

/**
 * Refine one edge's `(category, verdict)` from the concept-model table with the
 * evidence strength and run state the table cannot see. See the module doc.
 */
export const refineDeleteTier = (
  base: { readonly category: string; readonly verdict: string },
  edge: Edge,
  run: ReferrerRunState,
): { readonly category: string; readonly verdict: string } => {
  const { category, verdict } = base;
  if (
    category === 'apex' &&
    verdict === 'risky' &&
    edge.confidence !== 'heuristic' &&
    edge.properties['mechanism'] !== 'soql-string-literal'
  ) {
    return { category, verdict: 'blocking' };
  }
  if (category === 'frontend' && edge.properties['mechanism'] === 'schema-import') {
    return { category, verdict: 'blocking' };
  }
  if (category === 'omnistudio' && run.active === false) {
    return { category, verdict: 'review' };
  }
  if (category === 'rollup' && edge.source === 'dlrs-rollup' && run.active === false) {
    return { category, verdict: 'review' };
  }
  return base;
};

/**
 * Category -> the metadata families whose retrieval decides whether "no
 * referrer found" is a real absence. Drives `checkedCategories`; a drift test
 * pins that it covers every family in `USAGE_SOURCE_FAMILIES.CustomField`.
 */
export const DELETE_CATEGORY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  apex: ['ApexClass', 'ApexTrigger'],
  flow: ['Flow'],
  condition: [
    'Flow',
    'ValidationRule',
    'WorkflowRule',
    'ApprovalProcess',
    'AssignmentRule',
    'AutoResponseRule',
    'EscalationRule',
  ],
  workflow: ['WorkflowRule'],
  validation: ['ValidationRule'],
  layout: ['Layout', 'QuickAction', 'WebLink'],
  formula: ['CustomField'],
  rollup: ['CustomField', 'CustomMetadataRecord'],
  sharing: ['SharingRule', 'RestrictionRule', 'ScopingRule'],
  analytics: ['Report', 'Dashboard', 'ListView', 'ReportType'],
  ui: ['FlexiPage'],
  frontend: [
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
  ],
  omnistudio: [
    'OmniDataTransform',
    'OmniIntegrationProcedure',
    'OmniScript',
    'OmniUiCard',
  ],
};

/**
 * Families that can hold a reference to a CustomField but have no named delete
 * category: an EmailTemplate merge field ({!Object.Field__c}) is a `references`
 * edge to the field (CH-2) that classifies as `unknown`. They are still
 * field-referrer families, so the coverage caveat must name them when unread.
 */
export const FIELD_REFERRER_FAMILIES_WITHOUT_CATEGORY: readonly string[] = ['EmailTemplate'];

/** One row of `checkedCategories`. */
export interface CheckedCategory {
  readonly category: string;
  /** Distinct referrers found in this category (0 = none found). */
  readonly referrers: number;
  /**
   * `found` — referrers listed in `reasoning`; `none-found` — checked, and
   * every family behind it was retrieved; `not-checked` — nothing found, but a
   * family behind it is in the coverage gap, so absence proves nothing.
   */
  readonly status: 'found' | 'none-found' | 'partially-checked' | 'not-checked';
  /** Families behind this category the vault did not fully retrieve. */
  readonly missingFamilies?: readonly string[];
  /**
   * Missing families whose retrieve was CAPPED (e.g. the default report pull):
   * the retrieved members were checked, the rest were not. When every missing
   * family is capped and nothing was found, the status is `partially-checked`.
   */
  readonly cappedFamilies?: readonly string[];
  /** For a capped family, how many members were retrieved (and checked) of the org total. */
  readonly retrievedOf?: readonly CappedFamilyCount[];
}

/** Retrieved-vs-org-total for one capped family. */
export interface CappedFamilyCount {
  readonly family: string;
  readonly retrieved: number;
  readonly total: number;
}

/** Extra inputs to {@link buildCheckedCategories}. */
export interface CheckedCategoryOptions {
  /** Families whose retrieve was capped (attempted, partial). */
  readonly cappedFamilies?: readonly string[];
  /** Retrieved-vs-total counts for capped families, when the manifest records them. */
  readonly cappedCounts?: readonly CappedFamilyCount[];
  /** Categories outside the edge walk: their families + why one was not run. */
  readonly extra?: readonly {
    readonly category: string;
    readonly families: readonly string[];
    readonly referrers: number;
    readonly skipped?: boolean;
    /** Families behind this row that were not read, whatever the retrieve coverage says. */
    readonly unreadFamilies?: readonly string[];
  }[];
}

/**
 * Every delete category the tool checked — including the empty ones — so a
 * reader can tell "checked, none" from "not checked" (A10).
 */
export const buildCheckedCategories = (
  referrersByCategory: ReadonlyMap<string, number>,
  missingCoverage: readonly string[],
  options: CheckedCategoryOptions = {},
): readonly CheckedCategory[] => {
  const missing = new Set(missingCoverage);
  const capped = new Set(options.cappedFamilies ?? []);
  const row = (
    category: string,
    families: readonly string[],
    referrers: number,
    skipped = false,
    unread: readonly string[] = [],
  ): CheckedCategory => {
    const missingFamilies = families.filter((f) => missing.has(f) || unread.includes(f));
    const cappedFamilies = missingFamilies.filter((f) => capped.has(f) && !unread.includes(f));
    const status: CheckedCategory['status'] =
      referrers > 0
        ? 'found'
        : skipped
          ? 'not-checked'
          : missingFamilies.length === 0
            ? 'none-found'
            : cappedFamilies.length === missingFamilies.length
              ? 'partially-checked'
              : 'not-checked';
    const retrievedOf = (options.cappedCounts ?? []).filter((c) =>
      cappedFamilies.includes(c.family),
    );
    return {
      category,
      referrers,
      status,
      ...(missingFamilies.length > 0 ? { missingFamilies } : {}),
      ...(cappedFamilies.length > 0 ? { cappedFamilies } : {}),
      ...(retrievedOf.length > 0 ? { retrievedOf } : {}),
    };
  };
  return [
    ...Object.entries(DELETE_CATEGORY_FAMILIES).map(([category, families]) =>
      row(category, families, referrersByCategory.get(category) ?? 0),
    ),
    ...(options.extra ?? []).map((e) =>
      row(e.category, e.families, e.referrers, e.skipped, e.unreadFamilies),
    ),
  ];
};

/** OmniStudio types other OmniStudio components (or Apex) invoke by name. */
const INVOKED_OMNI_TYPES = new Set(['OmniDataTransform', 'OmniIntegrationProcedure']);
const CALLED_BY_LIMIT = 5;

/** How many of a referrer's callers run. */
export interface OmniCallerCounts {
  readonly total: number;
  readonly active: number;
  /** Callers recorded as not running (the rest have no recorded state). */
  readonly inactive: number;
}

/** What {@link omniCallerContext} learned about an invoked OmniStudio referrer. */
export interface OmniCallerContext {
  /** Up to 5 caller ids: active callers first, then unknown-state, then inactive. */
  readonly calledBy: readonly ComponentId[];
  readonly callers: OmniCallerCounts;
  /**
   * The referrer's run state, derived from its callers. Set only for a
   * DataMapper (see {@link omniCallerContext}); other types keep their own flag.
   */
  readonly run?: ReferrerRunState;
}

/**
 * ADM-1 / B10: an OmniStudio referrer is usually a DataMapper that an
 * Integration Procedure or OmniScript calls, and deleting the field breaks the
 * CALLER too. Returns the components that dispatch `node` (incoming
 * `dispatchesOmniAction`), active ones first, with how many of them run.
 *
 * A DataMapper's own `<active>` flag does not say whether it runs: real orgs
 * have active Integration Procedures calling DataMappers flagged inactive. So a
 * DataMapper's run state comes from its callers: running when any caller is
 * active, unknown when a caller has no recorded state or there are no modeled
 * callers (Apex or an LWC may call it by name), and not running only when every
 * modeled caller is inactive and the DataMapper is not flagged active itself.
 * Returns `null` for types nothing invokes by name.
 */
export const omniCallerContext = async (
  graph: GraphStore,
  node: Node,
): Promise<OmniCallerContext | null> => {
  if (!INVOKED_OMNI_TYPES.has(node.type)) return null;
  const r = await listEdges(graph, node.id, { direction: 'in', edgeType: 'dispatchesOmniAction' });
  const ids = r.ok ? [...new Set(r.value.map((e) => e.fromId))] : [];
  const states = await Promise.all(
    ids.map(async (id) => {
      const n = await getNodeById(graph, id);
      const active = n.ok && n.value !== null ? ownRunState(n.value).active : null;
      return { id, active };
    }),
  );
  const rank = (a: boolean | null): number => (a === true ? 0 : a === null ? 1 : 2);
  states.sort((a, b) => rank(a.active) - rank(b.active) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const callers: OmniCallerCounts = {
    total: states.length,
    active: states.filter((s) => s.active === true).length,
    inactive: states.filter((s) => s.active === false).length,
  };
  const base = { calledBy: states.slice(0, CALLED_BY_LIMIT).map((s) => s.id), callers };
  if (node.type !== 'OmniDataTransform') return base;
  if (callers.active > 0) return { ...base, run: { active: true, status: 'Active' } };
  const allInactive = callers.total > 0 && callers.inactive === callers.total;
  if (allInactive && ownRunState(node).active !== true) {
    return { ...base, run: { active: false, status: 'Inactive' } };
  }
  return { ...base, run: { active: null } };
};
