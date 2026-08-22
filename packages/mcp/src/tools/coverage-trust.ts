/**
 * Shared coverage-aware trust helpers for destructive and what-if tools.
 */

import type { TrustSummary } from '@sf-intelligence/contracts';
import { buildMixedFreshness, summarizeCoverage } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

export interface CoverageCaveat {
  readonly status: 'partial' | 'unknown';
  readonly missingCoverage: readonly string[];
  readonly message: string;
  /**
   * GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE (L1 residual): structured, host-citable
   * blind spots behind an absence-based destructive verdict. Present ONLY when at
   * least one blind spot is an `extractor-blind` plane (a family the vault DID
   * retrieve but whose edges the extractor is KNOWN not to emit for a given ref
   * shape) — the residual a bare `missingCoverage` list cannot express, because
   * that list names only UN-retrieved families. When every blind spot is merely
   * `not-retrieved` the caveat stays byte-identical to the pre-residual shape (no
   * `blindSpots` key) — the un-retrieved planes are already named in
   * `missingCoverage`. See {@link BlindSpot} / {@link assertUsageCompleteness}.
   */
  readonly blindSpots?: readonly BlindSpot[];
}

/**
 * One structured, host-citable reason a "0 inbound edges ⇒ safe" verdict cannot
 * be trusted (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE, L1 residual). Two kinds:
 *
 *   - `not-retrieved`   — the referrer family was never (fully) retrieved into
 *     the vault, so a reference it could hold is invisible. This is the ORIGINAL
 *     L1 axis (retrieve coverage) — the family is named in `missingCoverage` too.
 *   - `extractor-blind` — the referrer family WAS retrieved, but the extractor is
 *     KNOWN not to emit an edge for a particular reference shape inside it (a
 *     `KNOWN_BLIND_EXTRACTOR_PLANE`). "0 inbound edges from a covered family" is
 *     therefore "not checked", not proven "none" — the exact false-safe the
 *     retrieve-coverage gate alone could NOT catch. This is the residual axis.
 */
export interface BlindSpot {
  /** The referrer family (plane) whose emptiness cannot be trusted. */
  readonly plane: string;
  /** Why the plane is blind — a retrieve gap, or a known extractor omission. */
  readonly kind: 'not-retrieved' | 'extractor-blind';
  /** Human-readable, host-citable detail (org-agnostic). */
  readonly detail: string;
}

/**
 * The unified severity verdict for the whole `what_if_*` family (P8-what-if-suite).
 *
 * Before the unification each tool redeclared its own `Verdict` with a
 * slightly different union — some carried `review` but not `unknown`, others
 * the reverse — so the same headline meant different things tool to tool.
 * This is the single superset. Widening any tool's local union to this is a
 * pure type-level change: no handler ever produced a value outside the set it
 * already used, so runtime output is unchanged.
 *
 *   - `safe`     — no impacts found and coverage is complete.
 *   - `review`   — impacts found, or a `safe` result whose coverage is partial
 *                  (absence is "not checked", not proven; see `coverageCaveat`).
 *   - `risky`    — impacts found that likely break callers/automation.
 *   - `blocking` — a hard metadata blocker (the change cannot be made as-is).
 *   - `unknown`  — the tool could not classify (degraded/partial signal).
 *   - `already-inactive` — the component does not RUN in the org today
 *                  (Obsolete / Draft / InvalidDraft Flow, Inactive trigger), so
 *                  disabling it changes no runtime behaviour. A separate AXIS
 *                  from the five above, which describe the dependency
 *                  STRUCTURE: a tool emitting this also emits
 *                  `structuralVerdict` carrying what the structure says, so
 *                  "it is already off" is never confused with "nothing depends
 *                  on it". Deliberately NOT folded into `safe` — `safe` means
 *                  "no impacts at all", and reusing it would make an
 *                  inactive-but-heavily-depended-on component read identically
 *                  to a genuinely inert one.
 */
export type Verdict =
  | 'safe'
  | 'review'
  | 'risky'
  | 'blocking'
  | 'unknown'
  | 'already-inactive';

/**
 * The result envelope every `what_if_*` tool's `data` payload conforms to
 * (P8-what-if-suite). Tool-specific detail (impacts, conflicts, buckets) is
 * added on top by extending this base; the four common fields below are the
 * contract a caller can rely on regardless of which what-if they invoked.
 *
 * Conformance is asserted at compile time in
 * `test/tools/what-if-envelope.test.ts` — adding a tool that omits any of
 * these fails the build.
 */
export interface WhatIfEnvelope {
  /** Headline severity from the unified vocabulary above. */
  readonly verdict: Verdict;
  /** Present when a family this verdict depends on has incomplete coverage. */
  readonly coverageCaveat?: CoverageCaveat;
  /** Provenance / confidence / completeness for the answer. */
  readonly trust: TrustSummary;
  /** Verbatim boundary disclosure surfaced with every response. */
  readonly disclosure: string;
}

export const offlineTrust = (
  ctx: Context,
  completeness: TrustSummary['completeness'],
  involvedTypes?: readonly string[],
): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: buildMixedFreshness(ctx.manifest, involvedTypes),
  completeness,
  limitations: [],
});

/**
 * COVERAGE-CAVEAT-SENTENCE-UNGRAMMATICAL: the two grammatical slots every
 * coverage-caveat message is composed from.
 *
 * Every caveat message is built as `"<subject> cannot be confirmed …"`, so
 * `subject` MUST be a NOUN PHRASE ("Deletion safety", "The `Flow` inventory"),
 * never a finished sentence. That contract was implicit while every caller
 * happened to honour it, and it broke silently the moment one did not:
 * `buildEmptyTraversalCoverageCaveat` passed a two-sentence blob ending in a
 * VERB ("…the dependency families the vault actually retrieved"), so the four
 * graph-traversal tools rendered, verbatim, on EVERY empty result:
 *
 *   This is an EMPTY result. "Nothing references / uses this" can only be
 *   asserted for the dependency families the vault actually retrieved CANNOT
 *   BE CONFIRMED because the vault has incomplete coverage for: …
 *
 * — the product's central honesty sentence, in broken English. Splitting the
 * slots makes the contract explicit and checkable: prose that must precede the
 * claim goes in `preamble` (emitted verbatim, terminator and all), and only the
 * noun phrase reaches the verb. The rendered sentence for the traversal callers
 * is pinned in `test/tools/empty-traversal-coverage-caveat.test.ts`.
 */
export interface CoverageCaveatPurpose {
  /**
   * Optional lead-in emitted VERBATIM before the claim, including its own
   * terminating punctuation (e.g. `'This is an EMPTY result.'`). Use it for
   * context that is a sentence in its own right.
   */
  readonly preamble?: string;
  /**
   * The NOUN PHRASE that becomes the grammatical SUBJECT of
   * `"<subject> cannot be confirmed …"`. Never a full sentence, never
   * verb-final.
   */
  readonly subject: string;
}

/**
 * What a caller may pass as a caveat purpose. A bare string is the subject
 * (the shape every pre-existing caller uses, byte-identical), or the explicit
 * {@link CoverageCaveatPurpose} slots when a preamble is needed.
 */
export type CaveatPurpose = string | CoverageCaveatPurpose;

/**
 * Render `"<preamble> <subject> cannot be confirmed"` — the shared opening of
 * BOTH caveat messages (`buildCoverageCaveat`'s retrieve-coverage message and
 * `assertUsageCompleteness`'s merged blind-plane message), so the two cannot
 * drift into different grammar. Each caller appends its own continuation
 * (`" because …"` / `": …"`).
 *
 * Trailing sentence punctuation on the subject is stripped: a subject is a noun
 * phrase, and a stray full stop there would produce "X. cannot be confirmed".
 */
const coverageCaveatClaim = (purpose: CaveatPurpose): string => {
  const slots: CoverageCaveatPurpose =
    typeof purpose === 'string' ? { subject: purpose } : purpose;
  const preamble = (slots.preamble ?? '').trim();
  const subject = slots.subject.trim().replace(/[.,;:]+$/, '');
  return `${preamble === '' ? '' : `${preamble} `}${subject} cannot be confirmed`;
};

export const buildCoverageCaveat = (
  ctx: Context,
  requiredTypes: readonly string[],
  purpose: CaveatPurpose,
): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, requiredTypes);
  if (coverage.status === 'complete') return undefined;
  const missingCoverage = coverage.missingCoverage.length > 0
    ? coverage.missingCoverage
    : [...requiredTypes];
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage,
    message:
      `${coverageCaveatClaim(purpose)} because the vault has incomplete coverage for: ${missingCoverage.join(', ')}. Treat absence of dependencies in those families as "not checked", not "none".`,
  };
};

/**
 * Coverage caveat for type-scoped enumeration tools (`list_components`, …).
 * Attached whenever manifest coverage for the requested type is not `complete`,
 * including when the page is non-empty — a scoped refresh can leave stale rows
 * while the inventory is not authoritative. Skipped when the manifest carries
 * no coverage rows (pre-v4 vaults) so legacy vaults are not false-flagged.
 */
export const buildEnumerationCoverageCaveat = (
  ctx: Context,
  type: string,
): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, [type]);
  if (!coverage.coverageKnown || coverage.status === 'complete') return undefined;
  return buildCoverageCaveat(ctx, [type], `The \`${type}\` inventory`);
};

/**
 * coverage-aware-zero (CR): the multi-type sibling of
 * `buildEnumerationCoverageCaveat`. For a tool whose 0/empty assembly spans
 * several metadata families (e.g. process-builder migration over Flow /
 * WorkflowRule / ApprovalProcess), attach a caveat when ANY of the requested
 * types is not fully covered per the manifest, so a bare 0 reads "not
 * retrieved, re-refresh" instead of a proven "none".
 *
 * Guards identical to the single-type helper: returns undefined when the
 * manifest carries no coverage rows (pre-v4 / legacy vaults — never false-flag
 * them) or when every requested type retrieved clean (status `complete`). The
 * caveat's `missingCoverage` lists only the families actually not covered, so a
 * partially-covered set names exactly which family is "not checked".
 */
export const buildEnumerationCoverageCaveatFor = (
  ctx: Context,
  types: readonly string[],
  purpose: CaveatPurpose,
): CoverageCaveat | undefined => {
  if (types.length === 0) return undefined;
  const coverage = summarizeCoverage(ctx.manifest, types);
  if (!coverage.coverageKnown || coverage.status === 'complete') return undefined;
  return buildCoverageCaveat(ctx, types, purpose);
};

export const applyCoverageToVerdict = <V extends string>(
  verdict: V,
  caveat: CoverageCaveat | undefined,
  safeValue: V,
  reviewValue: V,
): V => {
  if (caveat === undefined) return verdict;
  return verdict === safeValue ? reviewValue : verdict;
};

// ---------------------------------------------------------------------------
// GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE — the shared usage-source coverage
// contract for destructive verdicts (delete / clean-unused / soft-uninstall).
// ---------------------------------------------------------------------------

/**
 * The families whose metadata can hold an INBOUND USAGE edge to a component of
 * a given type — the "who could reference / place / use me" set. A destructive
 * verdict that rests on "this component has 0 inbound usage edges" is only as
 * strong as the coverage of THESE families: if a family that could reference the
 * component was not retrieved / modeled (errored retrieve, scoped refresh,
 * staged build, or no extractor for it yet), the absence of edges is "not
 * checked", not proven "none" — so a bare `safe` would be a FALSE destructive
 * verdict (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE).
 *
 * This is deliberately NOT the component's own family (a fully-modeled
 * VisualforcePage tells you nothing about whether the CustomSite that names it
 * as its `<indexPage>` was retrieved) and deliberately NOT the structural
 * `parentOf` / access `grantedBy` producers (those are not usage). It is the set
 * of dependency PRODUCERS a delete/unused gate must have covered before it can
 * prove absence.
 *
 * An entry mapped to an EMPTY array is an assertion that NOTHING references this
 * type through the graph (an entry-point family that fires on its own — a
 * DuplicateRule / ValidationRule / ApexTrigger whose liveness, not its inbound
 * references, is what matters; that liveness floor lives in the individual
 * tools). An empty set yields NO coverage caveat, so those types keep their
 * table verdict rather than being blanket-downgraded.
 *
 * A type ABSENT from this map falls back to {@link DEFAULT_USAGE_SOURCE_FAMILIES}
 * (the broad producer union) — fail-closed, so a not-yet-mapped type can never
 * silently become a bare `safe` on a coverage-degraded vault.
 */
export const USAGE_SOURCE_FAMILIES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    // A CustomField's producers — the vetted field-deletion referrer set (the
    // same list `safe_to_delete_field` uses; keeping it here makes that tool and
    // review_change share ONE contract instead of two copies).
    CustomField: [
      'CustomField',
      'ValidationRule',
      'Flow',
      'ApexClass',
      'ApexTrigger',
      'Layout',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
      'VisualforcePage',
      'VisualforceComponent',
      'QuickAction',
      'WorkflowRule',
      // The remaining condition firers wired to extractConditions. Their
      // ConditionalContext nodes now emit `readsFrom` edges to the fields their
      // criteria TEST, so a field can carry a `condition` blocker hiding behind
      // any of these families — and without them listed, buildCoverageCaveat
      // stayed silent on an unretrieved family while the verdict read clean.
      'ApprovalProcess',
      'AssignmentRule',
      'AutoResponseRule',
      'EscalationRule',
      'SharingRule',
      'Report',
      'Dashboard',
      'ListView',
      'ReportType',
      'FlexiPage',
    ],
    // Screen flows are EMBEDDED (FlexiPage / Layout / quick action / LWC-Aura),
    // and any flow can be invoked from Apex or a parent flow. FlexiPage is the
    // plane whose omission a real-org favicon/index cluster proved blind.
    Flow: [
      'FlexiPage',
      'Layout',
      'QuickAction',
      'ApexClass',
      'Flow',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
    ],
    ApexClass: [
      'ApexClass',
      'ApexTrigger',
      'Flow',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
      'VisualforcePage',
      'VisualforceComponent',
      'QuickAction',
    ],
    // A VisualforcePage is PLACED by a CustomSite (`<indexPage>` / `<siteTemplate>`),
    // a CustomTab, a FlexiPage, a Layout, or a quick action — CustomSite is the
    // plane the site-index cluster proved blind.
    VisualforcePage: [
      'CustomSite',
      'CustomTab',
      'FlexiPage',
      'Layout',
      'QuickAction',
      'CustomApplication',
      'VisualforcePage',
    ],
    VisualforceComponent: ['VisualforcePage', 'VisualforceComponent', 'EmailTemplate'],
    // A CompactLayout is only ever ASSIGNED — by a CustomObject
    // (`<compactLayoutAssignment>`) or a RecordType — never referenced otherwise.
    CompactLayout: ['CustomObject', 'RecordType'],
    // A StaticResource is placed by a CustomSite (favoriteIcon/logo), a bundle,
    // a VF page/component, an EmailTemplate, or a Letterhead.
    StaticResource: [
      'CustomSite',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
      'VisualforcePage',
      'VisualforceComponent',
      'EmailTemplate',
      'Letterhead',
    ],
    QuickAction: ['Layout', 'FlexiPage', 'CustomObject'],
    WebLink: ['CustomObject', 'Layout', 'FlexiPage'],
    Layout: ['Profile', 'PermissionSet', 'RecordType', 'CustomObject'],
    CustomTab: ['CustomApplication', 'Profile', 'PermissionSet', 'FlexiPage'],
    EmailTemplate: ['WorkflowRule', 'ApexClass', 'Flow', 'ApprovalProcess', 'Letterhead'],
    Letterhead: ['EmailTemplate'],
    GlobalValueSet: ['CustomField'],
    // Integration / callout surface (W11 — INTEGRATION-ORPHAN-UNDER-THE-GATE).
    // A NamedCredential / ExternalDataSource / AuthProvider is a callout-trust
    // anchor: the ONLY things that reference it live on the callout plane — an
    // Apex `callout:{alias}` (ApexClass), a declared ExternalService binding, an
    // OmniStudio Integration Procedure callout alias, or (for an AuthProvider)
    // the NamedCredential / ExternalDataSource that names it as its
    // `authProvider`. Before this entry these types fell through to the broad
    // `DEFAULT_USAGE_SOURCE_FAMILIES` union, which (a) over-fired — a partial
    // Report / Dashboard / Layout plane that CANNOT reference a credential still
    // downgraded an unused-credential delete to `review` — and (b) under-fired on
    // an unknown-coverage vault (see the fail-harder call in `review-change.ts`).
    // Naming the precise callout-site families makes the gate fire iff the plane
    // that could actually reference the credential is the one not retrieved.
    NamedCredential: ['ApexClass', 'ExternalService', 'OmniIntegrationProcedure'],
    ExternalDataSource: ['ApexClass'],
    AuthProvider: ['NamedCredential', 'ExternalDataSource'],
    // Entry-point / fire-on-their-own families: nothing references them through
    // the graph, so 0 inbound edges is genuine and no coverage gap can hide a
    // referrer. Their real risk is LIVENESS, floored in the individual tools.
    ApexTrigger: [],
    ValidationRule: [],
    WorkflowRule: [],
    DuplicateRule: [],
    MatchingRule: [],
    // User-assignment families: "who holds this" is user-level data, not
    // metadata edges — their unused-ness is disclosed via live plane / notes, not
    // a metadata coverage gap.
    Profile: [],
    PermissionSet: [],
    Role: [],
    Group: [],
    Queue: [],
  });

/**
 * The broad producer union used for any component type NOT explicitly mapped in
 * {@link USAGE_SOURCE_FAMILIES}. Fail-closed: a not-yet-mapped type checks
 * coverage of every family that can produce a usage edge, so it can never
 * silently return a bare `safe` when the graph is coverage-degraded. Mirrors the
 * dependency producers the graph-traversal honesty surface already enumerates,
 * plus the placement families (CustomSite / CustomTab / WebLink / CompactLayout).
 */
export const DEFAULT_USAGE_SOURCE_FAMILIES: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'ValidationRule',
  'WorkflowRule',
  'Layout',
  'FlexiPage',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'QuickAction',
  'WebLink',
  'CompactLayout',
  'CustomField',
  'CustomObject',
  'CustomTab',
  'CustomSite',
  'CustomApplication',
  'EmailTemplate',
  'SharingRule',
  'Report',
  'Dashboard',
  'ListView',
];

/**
 * The usage-source families to check coverage for before proving a component of
 * `componentType` is unreferenced. Returns the type's explicit
 * {@link USAGE_SOURCE_FAMILIES} entry (including a deliberate empty array for
 * entry-point / user-assignment families), else the fail-closed
 * {@link DEFAULT_USAGE_SOURCE_FAMILIES}.
 */
export const usageSourceFamiliesFor = (componentType: string): readonly string[] =>
  USAGE_SOURCE_FAMILIES[componentType] ?? DEFAULT_USAGE_SOURCE_FAMILIES;

// ---------------------------------------------------------------------------
// GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE — L1 RESIDUAL: known-blind extractor planes.
//
// The retrieve-coverage gate above only caveats when a usage-source FAMILY was
// UN-RETRIEVED. The residual: a family can be fully RETRIEVED yet the extractor
// is KNOWN not to emit an edge for some reference shape inside it — so "0 inbound
// edges from that covered family" is still "not checked", not proven "none", and
// a destructive verdict floors to a false bare `safe` with an EMPTY caveat. This
// is the second completeness axis: EXTRACTOR blindness, orthogonal to RETRIEVE
// coverage.
// ---------------------------------------------------------------------------

/**
 * A reference shape a known extractor is BLIND to even when the referrer family
 * was retrieved. Registering one here is a deliberate, documented assertion that
 * "0 inbound edges from `referrerFamily` does NOT prove `<componentType>` is
 * unreferenced" — which forces the shared completeness contract to disclose the
 * plane rather than return bare `safe`. The moment a plane is genuinely closed
 * (the extractor starts emitting the edge), its entry is deleted here and the
 * gate stops firing for it — one source of truth for both the extractor kit and
 * the honesty gate.
 */
export interface KnownBlindPlane {
  /** The retrieved-but-blind referrer family (e.g. `LightningComponentBundle`). */
  readonly referrerFamily: string;
  /** The reference shape the extractor does not emit an edge for (documentation). */
  readonly refShape: string;
  /** Why the plane stays blind even though the family IS retrieved (host-citable). */
  readonly reason: string;
}

/**
 * The registry of KNOWN-BLIND EXTRACTOR PLANES, keyed by the component TYPE whose
 * destructive/absence verdict they endanger. An entry means: even on a vault that
 * fully RETRIEVED `referrerFamily`, the extractor emits NO usage edge for
 * `refShape`, so a "0 inbound edges" verdict on a component of the keyed type is
 * "not checked", not proven "none".
 *
 * SCOPE DISCIPLINE (why this is small, not a dumping ground):
 *   - The PLACEMENT planes the false-safe cluster proved blind — CustomSite
 *     `<indexPage>`/`<siteTemplate>`, object `<compactLayoutAssignment>`,
 *     `<listViewButtons>`, VF `standardController`, workflow-alert `template` —
 *     are CLOSED by the placement kit (their extractors now emit edges), so they
 *     are DELIBERATELY ABSENT here: registering a closed plane would re-flag
 *     fully-modeled components and break the calibrated `safe` controls.
 *   - Only planes that are STRUCTURALLY invisible (a reference the extractor
 *     cannot resolve from static metadata) belong here, so the gate stays
 *     calibrated — a per-type disclosure with a named reason, never a blanket
 *     "everything is review".
 *
 * A type ABSENT from this map has no known-blind plane and keeps its pure
 * retrieve-coverage behaviour (byte-identical to the pre-residual gate).
 */
export const KNOWN_BLIND_EXTRACTOR_PLANES: Readonly<
  Record<string, readonly KnownBlindPlane[]>
> = Object.freeze({
  // A StaticResource can be placed by an LWC/Aura bundle through a resource URL
  // whose NAME is assembled at runtime (`import X from '@salesforce/resourceUrl/'
  // + key`, `{!$Resource[expr]}`, `$Resource.get(name)`). The bundle families ARE
  // retrieved and the scanner resolves STATIC resourceUrl imports, but it cannot
  // follow a dynamically-built name — so a StaticResource referenced ONLY that way
  // has 0 inbound edges on a fully-covered vault. This is a permanent structural
  // blindness (the same one `unused_components`' StaticResource note discloses),
  // NOT a retrieve gap, so it lives here rather than in retrieve coverage.
  StaticResource: [
    {
      referrerFamily: 'LightningComponentBundle',
      refShape:
        "dynamically-built resourceUrl (import from '@salesforce/resourceUrl/' + name, {!$Resource[expr]})",
      reason:
        'The LWC scanner resolves static resourceUrl imports but cannot follow a resource name assembled at runtime, so a StaticResource referenced only through a dynamic path has 0 inbound edges even when the LightningComponentBundle family is fully retrieved.',
    },
    {
      referrerFamily: 'AuraDefinitionBundle',
      refShape: 'dynamic $Resource / ltng:require resource expression',
      reason:
        'An Aura component that assembles a $Resource reference at runtime emits no declared edge, so a StaticResource used only that way stays invisible even when the AuraDefinitionBundle family is fully retrieved.',
    },
  ],
});

/**
 * The known-blind extractor planes for a component type (empty when none is
 * registered — the common case; a type with only retrieve-coverage risk).
 */
export const knownBlindPlanesFor = (
  componentType: string,
): readonly KnownBlindPlane[] => KNOWN_BLIND_EXTRACTOR_PLANES[componentType] ?? [];

/**
 * The unified completeness verdict for an absence-based destructive claim
 * (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE, L1 residual): the ONE contract
 * `review_change`, `unused_components`, `package_impact` and `safe_to_delete_field`
 * share. `complete` is true iff there is NO blind spot — neither an un-retrieved
 * usage-source family NOR a known-blind extractor plane. When `complete` is false
 * the `caveat` downgrades an otherwise-`safe`/clean/soft verdict and its
 * `blindSpots` give the host the structured, per-plane reasons.
 */
export interface UsageCompleteness {
  /** True iff nothing hides a referrer — safe to floor to `safe`/clean/soft. */
  readonly complete: boolean;
  /** Every blind spot (retrieve gaps + known-blind extractor planes). */
  readonly blindSpots: readonly BlindSpot[];
  /** The caveat to surface (carries `blindSpots` when any are extractor-blind); absent iff `complete`. */
  readonly caveat?: CoverageCaveat;
}

/** Arguments to {@link assertUsageCompleteness}. */
export interface AssertUsageCompletenessArgs {
  /**
   * The usage-source families whose RETRIEVE coverage is checked. Empty ⇒ the
   * retrieve axis is skipped (an entry-point / user-assignment type nothing can
   * reference through the graph).
   */
  readonly usageFamilies: readonly string[];
  /**
   * The component types whose KNOWN-BLIND EXTRACTOR planes are folded in. For a
   * single-component gate this is `[componentType]`; for a multi-type scan
   * (`unused_components`) it is every scanned type.
   */
  readonly blindPlaneTypes: readonly string[];
  /**
   * Purpose phrase used in the caveat message — a NOUN PHRASE, or the explicit
   * {@link CoverageCaveatPurpose} slots. See {@link CaveatPurpose}.
   */
  readonly purpose: CaveatPurpose;
  /**
   * Legacy-vault calibration for the RETRIEVE axis (unchanged from the prior
   * gate): `false` (default) does not caveat a pre-coverage vault; `true` treats
   * missing coverage rows as not-provably-complete (fail-harder). Does NOT affect
   * the EXTRACTOR-blind axis — a known-blind plane fires regardless of coverage.
   */
  readonly fireOnUnknownCoverage?: boolean;
}

/**
 * The central L1 completeness assertion. Composes the two axes:
 *
 *   1. RETRIEVE coverage — the pre-residual behaviour, via the SAME
 *      `buildCoverageCaveat` / `buildEnumerationCoverageCaveatFor` machinery, so
 *      a pure retrieve-gap caveat is BYTE-IDENTICAL to the prior gate (no
 *      `blindSpots` key added — the families are already in `missingCoverage`).
 *   2. EXTRACTOR blindness — the residual axis, via {@link knownBlindPlanesFor}.
 *      A known-blind plane fires EVEN WHEN its family is fully retrieved, so a
 *      covered-family + omitted-edge component can no longer floor to bare `safe`.
 *
 * When (2) contributes at least one spot, the returned caveat carries the full
 * structured `blindSpots` (both axes) and a merged message — this is the only
 * path that adds the `blindSpots` key, so every existing retrieve-only caveat is
 * unchanged (golden-lock).
 */
export const assertUsageCompleteness = (
  ctx: Context,
  args: AssertUsageCompletenessArgs,
): UsageCompleteness => {
  const { usageFamilies, blindPlaneTypes, purpose } = args;
  const fireOnUnknownCoverage = args.fireOnUnknownCoverage === true;

  // Axis 1 — RETRIEVE coverage (unchanged machinery ⇒ byte-identical caveat).
  const retrieveCaveat =
    usageFamilies.length === 0
      ? undefined
      : fireOnUnknownCoverage
        ? buildCoverageCaveat(ctx, usageFamilies, purpose)
        : buildEnumerationCoverageCaveatFor(ctx, usageFamilies, purpose);
  const notRetrievedSpots: BlindSpot[] =
    retrieveCaveat === undefined
      ? []
      : retrieveCaveat.missingCoverage.map((family) => ({
          plane: family,
          kind: 'not-retrieved',
          detail: `The \`${family}\` family was not fully retrieved into this vault, so a reference it could hold is invisible — "not checked", not proven "none".`,
        }));

  // Axis 2 — KNOWN-BLIND EXTRACTOR planes (fire regardless of retrieve coverage).
  const extractorBlindSpots: BlindSpot[] = [];
  for (const type of blindPlaneTypes) {
    for (const plane of knownBlindPlanesFor(type)) {
      extractorBlindSpots.push({
        plane: plane.referrerFamily,
        kind: 'extractor-blind',
        detail: `${plane.reason} (blind reference shape: ${plane.refShape})`,
      });
    }
  }

  // No extractor-blind spot ⇒ the pure retrieve-coverage path: return the legacy
  // caveat UNCHANGED (no `blindSpots` key) so existing consumers/fixtures stay
  // byte-identical; still expose the structured `blindSpots` at the top level.
  if (extractorBlindSpots.length === 0) {
    return {
      complete: retrieveCaveat === undefined,
      blindSpots: notRetrievedSpots,
      ...(retrieveCaveat !== undefined ? { caveat: retrieveCaveat } : {}),
    };
  }

  // Extractor-blind present ⇒ build the merged, structured caveat. Absence is
  // "not checked" even on a fully-covered vault, so this can never be `complete`.
  const blindSpots = [...notRetrievedSpots, ...extractorBlindSpots];
  const missingCoverage = [...new Set(blindSpots.map((s) => s.plane))];
  const status: CoverageCaveat['status'] = retrieveCaveat?.status ?? 'partial';
  const retrieveClause =
    notRetrievedSpots.length > 0
      ? ` Un-retrieved families: ${notRetrievedSpots.map((s) => s.plane).join(', ')}.`
      : '';
  const blindClause = extractorBlindSpots
    .map((s) => `${s.plane} (${s.detail})`)
    .join('; ');
  const message =
    `${coverageCaveatClaim(purpose)}: "0 inbound edges" is "not checked", not proven "none". ` +
    `The extractor is KNOWN not to emit edges for these covered-but-blind planes — ${blindClause}.${retrieveClause}`;
  return {
    complete: false,
    blindSpots,
    caveat: { status, missingCoverage, message, blindSpots },
  };
};

/**
 * The central destructive-verdict honesty check (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE):
 * given a component whose destructive verdict is about to rest on "0 inbound
 * usage edges", return a {@link CoverageCaveat} naming the usage-source families
 * the vault does NOT fully cover OR the KNOWN-BLIND extractor planes it cannot
 * see — or `undefined` when every family that could reference this type IS
 * covered AND no known-blind plane applies (so a genuinely-unused component of a
 * fully-covered, fully-modeled family still reads `safe`; this is a calibrated
 * contract, not a blanket floor).
 *
 * Thin wrapper over the shared {@link assertUsageCompleteness} contract so this
 * tool and its cousins share ONE completeness definition (both the retrieve and
 * the extractor-blind axes). The caller downgrades `safe` → `review` when this
 * returns a caveat (via {@link applyCoverageToVerdict} or the classifier's
 * `familyCovered` flag) and surfaces the caveat — now including structured
 * `blindSpots` when a covered-but-blind plane applies — so the host sees the
 * not-checked planes.
 *
 * `fireOnUnknownCoverage` tunes the legacy-vault calibration of the RETRIEVE axis
 * WITHOUT changing the contract:
 *   - `false` (default) — a pre-coverage vault (no coverage rows at all →
 *     `coverageKnown: false`) is NOT false-flagged on retrieve coverage, matching
 *     the enumeration / graph-traversal honesty surface.
 *   - `true` — a vault with no coverage rows reads as not-provably-complete and
 *     DOES caveat (the fail-harder stance `safe_to_delete_field` / `unused_
 *     components` take).
 * It does NOT gate the EXTRACTOR-blind axis: a known-blind plane fires on ANY
 * vault, because the blindness is in the extractor, not the retrieve.
 *
 * A type whose usage-source set is empty AND has no known-blind plane (an
 * entry-point / user-assignment family) always returns `undefined` — nothing can
 * reference it through the graph, so there is no gap that could hide a referrer.
 */
export const buildUsageSourceCoverageCaveat = (
  ctx: Context,
  componentType: string,
  purpose: string,
  opts?: { readonly fireOnUnknownCoverage?: boolean },
): CoverageCaveat | undefined =>
  assertUsageCompleteness(ctx, {
    usageFamilies: usageSourceFamiliesFor(componentType),
    blindPlaneTypes: [componentType],
    purpose,
    fireOnUnknownCoverage: opts?.fireOnUnknownCoverage === true,
  }).caveat;

/**
 * I3b (structural honesty — empty ≠ none): the coverage caveat a
 * graph-traversal tool (`get_impact`, `get_edges`, `get_subgraph`,
 * `find_component_usages`, `find_code_usages`, `find_apex_usages`,
 * `find_formula_references`) attaches ONLY when its edge / impact / usage set
 * came back EMPTY.
 *
 * An empty traversal result is exactly where "no X references this" is
 * dangerous: the host cannot tell an *empty* result (nothing referenced it)
 * from an *incomplete* one (the families that WOULD reference it were never
 * retrieved / modeled into the vault). This names the not-checked families so
 * the host discloses the boundary — "…among the families the vault covers;
 * families A/B/C were not checked" — instead of asserting absence as fact.
 *
 * Reuses the SAME machinery as the destructive / what-if suite
 * (`buildEnumerationCoverageCaveatFor` → `summarizeCoverage`): it returns
 * `undefined` when the requested families are fully covered (`complete`) OR
 * when the manifest carries no coverage rows at all (pre-v4 / legacy vault —
 * never false-flag those, per the vault-coverage-honesty rule). No new caveat
 * vocabulary is introduced.
 *
 * The phrasing is uniform across the traversal tools and is composed from the
 * two {@link CoverageCaveatPurpose} slots — a `preamble` that states the answer
 * IS empty, and the quoted claim as the SUBJECT of "cannot be confirmed" — so
 * the message reads as a boundary on the empty answer, not a boundary on a
 * non-empty one (callers only invoke this on an empty set). The exact rendered
 * sentence is pinned per caller in
 * `test/tools/empty-traversal-coverage-caveat.test.ts`.
 */
export const buildEmptyTraversalCoverageCaveat = (
  ctx: Context,
  requiredTypes: readonly string[],
): CoverageCaveat | undefined =>
  buildEnumerationCoverageCaveatFor(ctx, requiredTypes, {
    // COVERAGE-CAVEAT-SENTENCE-UNGRAMMATICAL: these two slots used to be ONE
    // string, and the composed sentence read "…the vault actually retrieved
    // cannot be confirmed because…". The lead-in is a sentence of its own; only
    // the quoted NOUN PHRASE is the subject of "cannot be confirmed".
    preamble: 'This is an EMPTY result.',
    subject: '"Nothing references / uses this"',
  });

/**
 * Coverage families whose incoming edges a general graph-traversal
 * (`get_impact` / `get_edges` / `get_subgraph`) walks. These are the families
 * that PRODUCE inbound dependency edges — so an empty traversal that omits any
 * of them is "not checked", not proven "none". The list is the union of the
 * dependency producers the destructive suite already enumerates (the
 * `USAGE_SOURCE_FAMILIES.CustomField` field-referrer set) so the two honesty
 * surfaces name the same not-checked families.
 */
export const GRAPH_TRAVERSAL_REQUIRED_COVERAGE = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'ValidationRule',
  'WorkflowRule',
  'Layout',
  'FlexiPage',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'QuickAction',
  'CustomField',
  'CustomObject',
  'Report',
  'Dashboard',
  'ListView',
] as const;

/** Coverage families the code-usage tools (`find_code_usages`) read from. */
export const CODE_USAGE_REQUIRED_COVERAGE = [
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
] as const;

/** Coverage families the Apex-usage tool (`find_apex_usages`) reads from. */
export const APEX_USAGE_REQUIRED_COVERAGE = ['ApexClass', 'ApexTrigger'] as const;

/**
 * Coverage families the formula-reference tool (`find_formula_references`)
 * reads from. Formula `references` edges originate from formula CustomFields
 * (the formula tokenizer) and Validation Rules, so a missing `CustomField` /
 * `ValidationRule` pull means an empty result is "not checked".
 */
export const FORMULA_REFERENCE_REQUIRED_COVERAGE = [
  'CustomField',
  'ValidationRule',
] as const;

/** Coverage families that affect flow-deactivation what-if completeness. */
export const FLOW_DEACTIVATION_REQUIRED_COVERAGE = [
  'Flow',
  'ApexClass',
  'CustomObject',
  'EmailTemplate',
] as const;

/** Coverage families that affect trigger-disable what-if completeness. */
export const TRIGGER_DISABLE_REQUIRED_COVERAGE = [
  'ApexTrigger',
  'ApexClass',
  'CustomObject',
  'PlatformEvent',
] as const;

/** Coverage families that affect method-signature change what-if completeness. */
export const METHOD_SIGNATURE_REQUIRED_COVERAGE = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
] as const;

export const attachCoverageToWhatIf = (
  ctx: Context,
  requiredTypes: readonly string[],
  purpose: string,
  rawVerdict: string,
): {
  readonly verdict: string;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
} => {
  const coverageCaveat = buildCoverageCaveat(ctx, requiredTypes, purpose);
  const verdict = applyCoverageToVerdict(
    rawVerdict,
    coverageCaveat,
    'safe',
    'review',
  );
  const completeness: TrustSummary['completeness'] =
    coverageCaveat === undefined
      ? { status: 'complete' }
      : {
          status: coverageCaveat.status,
          missingCoverage: coverageCaveat.missingCoverage,
        };
  return {
    verdict,
    ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    trust: offlineTrust(ctx, completeness),
  };
};
