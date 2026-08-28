/**
 * Handler for the `sfi.find_component_usages` MCP tool — the universal
 * "where is this component used?" dispatcher (P12-USAGE-find-component-usages).
 *
 * One entry point for ANY canonical component type. It composes the two evidence
 * tiers the §C3 usage contract requires into ONE payload, instead of the agent
 * fanning out across find_field_anywhere / find_code_usages / get_impact / grep:
 *
 *   1. GRAPH tier — incoming dependency edges to the target, EXCLUDING access
 *      grants (`grantedBy`) and structural parent edges (`parentOf`) because
 *      access is not usage. Grouped by referrer type, each edge carrying its
 *      `confidence` (declared / parsed / heuristic).
 *   2. GREP supplement (`text-match` tier) — a literal search of the Apex source
 *      AND the frontend bundle source (LWC / Aura / Visualforce; bounded to the
 *      bundle directories) for the component's api name, catching references the
 *      graph does not model (dynamic SOQL, reflective access, `$Label` /
 *      `$Resource` / `@salesforce` module imports, CustomMetadataType /
 *      CustomLabel / StaticResource references). Over- and under-matches are
 *      disclosed (P14-USAGE-grep-frontend).
 *
 * The honesty anchor: an empty graph + empty grep is "no static evidence in the
 * vault", surfaced in `boundaries[]` — NEVER "nothing uses this". Phantom-aware:
 * a referenced-but-not-retrieved target still answers from its incoming edges.
 * Specialized tools (find_field_anywhere, layout_assignments, …) remain for a
 * deeper single-family answer; this unifies the common case.
 *
 * ACCESS-GRANT section: excluding `grantedBy` from the usage tier made "which
 * permission sets grant custom permission X?" unanswerable (a CustomPermission's
 * ONLY incoming edges are grants). Grants stay OUT of `graphReferrers` — access
 * is still not usage — but a `CustomPermission` target, or any target with zero
 * usage edges and >0 incoming `grantedBy` edges, surfaces its granters in a
 * SEPARATE `grantedBy` section so the grant surface stays answerable.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId, Edge, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, searchNodes, type GraphStore } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { NOT_USAGE_EDGE_TYPES } from './apex-reachability.js';
import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import {
  describeSupplementalFlowWriterScanBoundary,
  scanSupplementalFlowFieldWriters,
  type SupplementalFlowFieldWriter,
  type SupplementalFlowWriterScanTruncationCause,
} from './flow-field-writers-scan.js';
import { grepVaultSource, searchApexSourceHandler } from './search-apex-source.js';

/**
 * Incoming edge types that are NOT usage — access grants + structural parentage.
 * R6: DERIVED from apex-reachability's canonical `NOT_USAGE_EDGE_TYPES` rather
 * than re-typed, so this tool and `object_360` cannot drift apart on what
 * counts as a use.
 */
const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(NOT_USAGE_EDGE_TYPES);

/** Families whose graph usage tier is weak, so the grep supplement matters most. */
const GREP_RELIANT_PREFIXES: ReadonlySet<string> = new Set([
  'CustomMetadataType',
  'CustomMetadataRecord',
  'CustomSetting',
  'CustomLabel',
  'StaticResource',
]);

const GRAPH_REFERRER_SAMPLE = 25;
const GREP_LIMIT_DEFAULT = 30;

/**
 * Frontend bundle source the grep tier covers IN ADDITION to Apex
 * (P14-USAGE-grep-frontend): LWC (`.js`/`.html`), Aura
 * (`.cmp`/`.app`/`.evt` + their `.js` controllers), Visualforce
 * (`.page`/`.component`). `$Label.c.X` / `@salesforce/label/c.X` and
 * `$Resource.X` / `@salesforce/resourceUrl/X` references live here — an
 * Apex-only walk read CustomLabel / StaticResource as falsely unused.
 */
const FRONTEND_SUFFIXES = ['.js', '.html', '.cmp', '.app', '.evt', '.page', '.component'] as const;

/**
 * Bound the frontend walk to the bundle directories. Without this, an
 * UNZIPPED static resource's own `.js`/`.html` payload (under
 * `staticresources/`) would flood the matches with the resource's internals.
 */
const FRONTEND_DIR_RE = /\/(lwc|aura|pages|components)\//;

/**
 * BUNDLE directories — a strict subset of {@link FRONTEND_DIR_RE}, and the
 * only one that may decide self-match by DIRECTORY.
 *
 * These two patterns look interchangeable and are not, which is how one regex
 * ended up doing both jobs and getting the second one wrong. The distinction is
 * the on-disk layout:
 *
 *   BUNDLE  `lwc/myCmp/myCmp.js`, `aura/MyCmp/MyCmp.cmp` — one directory PER
 *           component, so a sibling file is the SAME component. Excluding the
 *           whole directory is correct.
 *   FLAT    `pages/Foo.page`, `components/Bar.component` — one directory for
 *           EVERY component of that type, so a sibling file is a DIFFERENT
 *           component. Excluding the whole directory discards every real
 *           Visualforce caller in the org.
 *
 * `FRONTEND_DIR_RE` must keep listing all four because it also bounds the grep
 * WALK, where flat directories genuinely belong. Only the self-match test
 * narrows to bundles.
 *
 * The pattern CAPTURES the bundle directory rather than merely detecting one,
 * because a bundle node's `sourcePath` comes in two shapes and slicing to the
 * last `/` is only right for one of them:
 *   - `.../lwc/myCmp`          — the DIRECTORY. This is what a real vault
 *     holds: `extractLightningComponentBundle` / `extractAuraDefinitionBundle`
 *     are handed the bundle directory, `stat` it and REFUSE a non-directory,
 *     then persist it verbatim as `sourcePath`. Slicing this to its last `/`
 *     yields `.../lwc/` — the parent of EVERY bundle in the org.
 *   - `.../lwc/myCmp/myCmp.js` — a FILE inside it.
 * Capturing `(lwc|aura)/<bundleName>` handles both and can never widen to the
 * `lwc/` root, which would discard every genuine LWC/Aura caller in the org.
 */
const BUNDLE_DIR_RE = /^((?:.*\/)?(?:lwc|aura)\/[^/]+)(?:\/|$)/;

/**
 * The bundle directory (trailing `/`) that owns `p`, or null when `p` is not
 * part of an LWC / Aura bundle.
 */
const bundleDirOf = (p: string): string | null => {
  const m = BUNDLE_DIR_RE.exec(p);
  return m === null ? null : `${m[1]!}/`;
};

/** File name up to its first dot — `Foo.page` and `Foo.page-meta.xml` share `Foo`. */
const basenameStem = (p: string): string => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
};

/**
 * Per-type blind-spot notes appended when a component of this type has NO
 * static evidence (P14-USAGE-flow-object-boundaries): the generic
 * empty≠absent boundary says absence isn't proof, but each of these families
 * has a SPECIFIC, known hole an "unused" verdict must name — uniform across
 * the four types the §C3 audit flagged as non-uniform.
 */
const TYPE_EMPTY_NOTES: Readonly<Record<string, string>> = {
  Flow: 'Flow-specific blind spot: subflow and automation references are modeled, but screen-flow LAUNCH POINTS — quick actions, buttons, utility bar items, Experience/community pages — are mostly invisible to the graph. A flow with no referrers here may still be launched by users every day.',
  CustomObject:
    'CustomObject-specific blind spot: references from reports beyond the usage-ranked pull, list-view filters, email templates, and record-level data are not (or only partially) modeled — and standard objects are referenced implicitly platform-wide. Do not treat an empty referrer list as "this object is unused".',
  RecordType:
    'RecordType-specific blind spot: profile / permission-set record-type ASSIGNMENTS are access (grantedBy), which this tool deliberately excludes from usage — a record type with no usage referrers may be actively assigned and in daily use. Check recordtype_availability for the assignment surface.',
  ValidationRule:
    'ValidationRule-specific note: validation rules are CONSUMERS of fields, not components other metadata typically references — an empty incoming-referrer list is the EXPECTED shape, not evidence the rule is inactive or unused. Its own field references are its outgoing edges.',
  ListView:
    'ListView-specific note: list views are CONSUMERS of fields — nothing references a list view, so an empty incoming-referrer list is the EXPECTED shape, not evidence it is unused (user pinning/last-viewed is runtime data the vault never sees). Its filter-field references are its outgoing edges; who can SEE it is list_view_sharing (P14-USAGE-listview-general).',
};

export const findComponentUsagesInputSchema = z.object({
  componentId: z.string().min(1),
  /** Run the Apex-source grep supplement (default true). */
  includeGrep: z.boolean().optional(),
  /** Max grep matches to return (default 30, max 100). */
  grepLimit: z.number().int().min(1).max(100).optional(),
});
export type FindComponentUsagesInput = z.infer<typeof findComponentUsagesInputSchema>;

/** One modeled incoming referrer. */
export interface GraphReferrer {
  readonly referrerId: ComponentId;
  readonly viaEdge: string;
  readonly confidence: string;
}

/** Incoming referrers grouped by the referrer's component type. */
export interface ReferrerGroup {
  readonly referrerType: string;
  /**
   * EDGE count, not component count. One referrer reaches a target through as
   * many edges as it has relationships to it — a Flow that reads, writes AND
   * triggers on an object contributes 3. Measured on a real vault:
   * `{ referrerType: 'Flow', count: 77 }` for a hub object where only 53
   * distinct Flows reference it, a 45% over-count if read as "77 flows use
   * this". Read `distinctReferrers` for the component-count answer.
   */
  readonly count: number;
  /**
   * DISTINCT referring components of this type. Always `<= count`; the two
   * differ exactly when a referrer has more than one relationship to the
   * target. This is the number to quote to a human.
   */
  readonly distinctReferrers: number;
  /**
   * Up to `GRAPH_REFERRER_SAMPLE` edge rows, id-sorted — each row carries its
   * own `viaEdge` / `confidence`, so a multi-edge referrer legitimately appears
   * more than once here. The cap is on ROWS, so a group with many multi-edge
   * referrers shows fewer than `GRAPH_REFERRER_SAMPLE` distinct components (a
   * real hub's Flow sample held 20 distinct flows in 25 rows).
   */
  readonly sample: readonly GraphReferrer[];
}

/**
 * Access-grant section: the containers (Profiles / PermissionSets / record-type
 * assignments) whose incoming `grantedBy` edges point at the target, listed
 * SEPARATELY from usages because access is not usage. `count` is the full
 * distinct-granter count; `granters` is a sorted sample (cap
 * `GRAPH_REFERRER_SAMPLE`).
 */
export interface GrantedBySection {
  readonly count: number;
  readonly granters: readonly { readonly id: ComponentId; readonly type: string }[];
}

/**
 * FCU-FLOW-FIELD-WRITERS-UNCONSULTED — the third evidence tier, and the only
 * one that exists because the graph CANNOT carry it.
 *
 * A Flow that writes a field through an SObject VARIABLE
 * (`<assignToReference>Var.Field__c</assignToReference>`) or through a
 * `<recordCreates>` / `<recordUpdates>` `<inputAssignments>` block mints NO
 * `writesTo` edge, so the graph tier reports zero referrers; and the grep tier
 * searches for the QUALIFIED `Object.Field` string, which Flow XML never
 * writes. Measured on a real vault, this tool answered `graphReferrers: []`,
 * `hasStaticEvidence: false`, `grepMatchCount: 0` and a `coverageCaveat`
 * naming two UN-RETRIEVED analytics families as THE reason the empty could be
 * false — while `safe_to_delete_field` on the identical id returned `blocking`
 * on an ACTIVE Flow, from a family the vault had retrieved COMPLETELY. The
 * caveat steered the reader at the one place the answer was not hiding.
 *
 * So this tool now runs the SAME supplemental source scan its siblings run
 * (`flow-field-writers-scan`, shared with `safe_to_delete_field`, `field_360`
 * and `why_field_changed`) rather than growing a fourth private copy of it.
 *
 * Present ONLY when the tier actually ran — a `CustomField:Object.Field`
 * target whose graph usage tier came back EMPTY, which is the shape where this
 * plane decides the answer. That gate is NOT narrow: on a real production vault
 * 1,646 CustomField nodes have an empty graph usage tier, and each such call
 * pays a full Flow source walk (275 files on that vault) plus one extra source
 * read per `inputAssignments` candidate for the object re-derivation below.
 * Its absence is reported in a TYPED field a machine cannot skip:
 * `summary.supplementalFlowWriterCount` is `null` exactly when this section is
 * absent OR the scan could not prove its zero.
 */
export interface SupplementalFlowWritersSection {
  readonly tier: 'source-scan';
  /**
   * OBJECT-CONFIRMED writers only — every row here was resolved to THIS field's
   * object (an `assignToReference` through an SObject variable of that type, or
   * an `inputAssignments` inside a DML whose `<object>` / `<inputReference>`
   * resolves to it). Rows the shared scan matched on the FIELD NAME ALONE are
   * NOT here: a resolved but DIFFERENT object is dropped outright, and an
   * unresolvable one goes to {@link objectUnverified}. Capped at
   * `GRAPH_REFERRER_SAMPLE` rows — see {@link sampleTruncated}.
   */
  readonly writers: readonly {
    readonly flowId: ComponentId;
    readonly apiName: string;
    readonly mechanism: SupplementalFlowFieldWriter['mechanism'];
  }[];
  /**
   * ROW count, not Flow count — the scan emits one row per matching
   * `<assignToReference>` / `<inputAssignments>` occurrence, so a Flow that
   * writes the field from four branches contributes four. Measured on a real
   * vault: 8 rows from 2 distinct Flows, a 4x over-count if read as "8 flows
   * write this". This is the same edge-count-reads-as-component-count trap
   * `graphReferrers` already carries `distinctReferrers` for; quote
   * {@link distinctWriters} to a human.
   */
  readonly count: number;
  /** DISTINCT writing Flows. Always `<= count`. The human-facing number. */
  readonly distinctWriters: number;
  /** Flow source files actually READ (N in the "N of M" disclosure). */
  readonly scannedFlows: number;
  /** Flow nodes in the vault (M). */
  readonly totalFlows: number;
  /**
   * True when the writer set is NOT proven — the walk was capped, the graph
   * query failed, or a Flow source file could not be opened. An empty
   * `writers` under `truncated: true` is UNCHECKED, never "none".
   */
  readonly truncated: boolean;
  /** Which axis fired; `'none'` exactly when {@link truncated} is false. */
  readonly truncationCause: SupplementalFlowWriterScanTruncationCause;
  /**
   * True when either writer list was cut to the `GRAPH_REFERRER_SAMPLE` row
   * cap. Folded into the payload-level `truncated` exactly as the graph tier's
   * own sample cap is, so a caller reading one boolean is never told the answer
   * is complete while a list underneath it is short.
   */
  readonly sampleTruncated: boolean;
  /**
   * LEADS, NOT EVIDENCE. Flows where the field NAME appears in a
   * `<recordCreates>`/`<recordUpdates>` `<inputAssignments>` block whose own
   * object could NOT be resolved from the source, so it is unknown whether the
   * write lands on THIS object or on a same-named field elsewhere. These never
   * set `hasStaticEvidence` and never suppress `coverageCaveat`; confirm by
   * reading the Flow. ALWAYS present — a `count` of 0 is a checked zero, and
   * omitting the key would make "none to report" indistinguishable from "this
   * distinction was never drawn".
   */
  readonly objectUnverified: {
    readonly writers: readonly {
      readonly flowId: ComponentId;
      readonly apiName: string;
      readonly mechanism: SupplementalFlowFieldWriter['mechanism'];
    }[];
    /** ROW count of unresolved-object name matches. */
    readonly count: number;
    /** DISTINCT Flows behind {@link count}. */
    readonly distinctWriters: number;
  };
  /**
   * Rows the shared scan reported that this tool DROPPED because the enclosing
   * DML resolved to a DIFFERENT object — a same-named field on another object,
   * not a reference to this one. Reported as a number so the discrepancy
   * between this tool and `sfi.safe_to_delete_field` (which does not scope the
   * match) is visible rather than mysterious.
   */
  readonly otherObjectMatchesDropped: number;
}

export interface FindComponentUsagesOutput {
  readonly target: {
    readonly componentId: ComponentId;
    readonly type: string;
    readonly apiName: string;
    readonly retrieved: boolean;
    /**
     * The id the CALLER passed when it differed from the vault's spelling only
     * by CASE, else `null`. `componentId` above is always the vault's EXACT
     * casing — never echo the caller's, or the response asserts a component id
     * that does not exist. Always present (never `undefined`) so a host cannot
     * read "no correction" and "field not emitted" as the same thing.
     */
    readonly resolvedFrom: string | null;
  };
  readonly graphReferrers: readonly ReferrerGroup[];
  readonly grepSupplement: {
    readonly tier: 'text-match';
    readonly ran: boolean;
    readonly query: string | null;
    /**
     * Count AFTER excluding the component's own definition (its declaring
     * file, or — for a bundle component — any file in its own bundle
     * directory). A match on a class's own `class Foo {` line is not
     * evidence anything ELSE uses it; see {@link selfMatchesExcluded}.
     */
    readonly matchCount: number;
    readonly matches: readonly { readonly path: string; readonly line: number; readonly snippet: string }[];
    readonly truncated: boolean;
    /**
     * How many raw grep hits were the component's OWN definition and were
     * removed before `matchCount` / `matches` were computed — 0 when grep
     * did not run, found nothing, or found only genuine external matches.
     * Present so a caller can tell "grep ran and found only its own
     * declaration" (this field > 0, `matchCount: 0`) apart from "grep ran
     * and found nothing at all" (this field 0, `matchCount: 0`) rather than
     * reading both as an identical bare zero.
     */
    readonly selfMatchesExcluded: number;
  };
  /**
   * Grants listed SEPARATELY from usages (`graphReferrers` still excludes
   * `grantedBy` — access is not usage). Present ONLY when the target is a
   * `CustomPermission` (whose natural question is "which containers GRANT
   * it?" — its only incoming edges are grants) or when the target has ZERO
   * usage edges but >0 incoming `grantedBy` edges. Absent otherwise, so a
   * normal usage answer is byte-identical to before.
   */
  readonly grantedBy?: GrantedBySection;
  /** See {@link SupplementalFlowWritersSection}. Absent when the tier did not run. */
  readonly supplementalFlowWriters?: SupplementalFlowWritersSection;
  readonly summary: {
    /**
     * Total incoming USAGE **edges** — NOT the number of components that use
     * the target. `grantedBy.count` next to it IS a distinct count, so the two
     * were not comparable despite both being called a count. Measured on a real
     * hub object: 162 edges from 138 distinct referrers.
     */
    readonly graphReferrerCount: number;
    /** DISTINCT referring components across all types — the human-facing number. */
    readonly distinctReferrerCount: number;
    readonly grepMatchCount: number;
    /**
     * DISTINCT Flows found writing this field by the supplemental source scan
     * (see {@link SupplementalFlowWritersSection}) — the component count, not
     * the row count; `null` when that plane was
     * NOT CHECKED — the tier did not apply (non-`CustomField` target, or the
     * graph tier already answered), or it ran but could not prove its zero.
     * `null` is the typed absence marker: a bare `0` here would collapse
     * "scanned every Flow, found none" into "never looked", which is the
     * defect this field exists to prevent.
     */
    readonly supplementalFlowWriterCount: number | null;
    /**
     * DISTINCT Flows in the object-UNVERIFIED bucket — a name-only
     * `<inputAssignments>` match whose enclosing DML object could not be
     * resolved. These are LEADS, never evidence: they are excluded from
     * {@link supplementalFlowWriterCount} and from `hasStaticEvidence`. `null`
     * exactly when {@link supplementalFlowWriterCount} is `null` (the plane was
     * NOT CHECKED), so the two absence markers cannot drift apart.
     */
    readonly supplementalFlowWriterUnverifiedCount: number | null;
    readonly referrerTypes: readonly string[];
    readonly hasStaticEvidence: boolean;
  };
  readonly boundaries: readonly string[];
  /**
   * I3b (empty ≠ none): present ONLY when there is NO static evidence anywhere
   * (empty graph tier AND empty grep tier) AND a dependency family that would
   * reference this component is NOT fully covered by the vault. Names the
   * not-checked families so an empty usage answer reads "not retrieved", not a
   * proven "none". Absent when static evidence exists or the vault is fully
   * covered (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
  readonly truncated: boolean;
}

const typeOf = (id: string): string => {
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : id;
};
const apiNameOf = (id: string): string => {
  const i = id.indexOf(':');
  return i > 0 ? id.slice(i + 1) : id;
};

/**
 * Ceiling on the case-variant probe. The probe is an indexed ILIKE that runs
 * ONLY after the exactly-cased id has already missed, so the cost is paid once,
 * on the path that was about to fail anyway. 100 is `searchNodes`' own maximum
 * and is far above any real fold-collision count: `searchNodes` scores an
 * ILIKE prefix hit at 2.8 and breaks ties by `length(api_name) ASC`, so a name
 * that folds EQUAL to the query is the shortest possible prefix match and sorts
 * to the front of the first page.
 */
const CASE_VARIANT_LIMIT = 100;

/** Outcome of the case-variant probe. */
interface CaseVariantProbe {
  /** Vault ids that fold to the requested id, sorted. Usually 0 or 1. */
  readonly variants: readonly string[];
  /**
   * True when the probe found NO variant AND its bounded name search came back
   * FULL — a variant past that window cannot be ruled out. The refusal must say
   * "not found within a bounded probe", never "there is no case variant": an
   * unchecked zero wearing a checked zero's clothes is the defect this whole
   * file is being repaired for.
   */
  readonly saturated: boolean;
}

/**
 * Vault ids that equal `componentId` IGNORING CASE — in BOTH halves.
 *
 * FCU-WRONG-CASE-ID-READS-AS-ABSENT: Salesforce api names are case-insensitive
 * — in SOQL, in a formula and in the Setup UI — so a caller who types the
 * lower-case form of a real component is not naming a different component. This
 * tool is the universal "where is X used?" dispatcher, so it receives whatever
 * string the user typed (a name read off a spreadsheet, say). Measured on a
 * real vault, the exactly-cased id returned a full answer while the SAME id
 * lower-cased returned a `component-not-found` whose kind, message template and
 * payload size were IDENTICAL to the one a fabricated one-character typo
 * produced — so a host could not tell "wrong case of something real" from "does
 * not exist", and the natural recovery is to report an ACTIVE component absent
 * from the org.
 *
 * The search token is the LAST dotted segment of the api-name half, NOT the
 * half itself, because `nodes.api_name` is the BARE leaf for every child-scoped
 * family: a `CustomField:Object.Field__c` node stores `api_name` = `Field__c`
 * (the object lives in the id and the parent link), so searching the qualified
 * `Object.Field__c` string matches NOTHING — verified against a real vault,
 * where it silently made every field, record type, validation rule and list
 * view immune to this repair. The full id is what the filter compares.
 *
 * The list is returned rather than a decision because two vault ids that fold
 * to the same name are TWO components: case-insensitive RESOLUTION must never
 * become case-insensitive IDENTITY. See {@link caseAmbiguityMessage}.
 *
 * Mirrors `input-aliases.ts` `objectIdCaseVariants`, which solved this for the
 * object-scoped surface; that helper is `CustomObject`-only, this one is
 * type-parametric because this tool dispatches over every canonical type.
 */
const idCaseVariants = async (
  graph: GraphStore,
  componentId: string,
): Promise<Result<CaseVariantProbe, McpError>> => {
  const apiName = apiNameOf(componentId);
  const dot = apiName.lastIndexOf('.');
  const leaf = dot === -1 ? apiName : apiName.slice(dot + 1);
  if (leaf.length === 0) return ok({ variants: [], saturated: false });
  // No `types` narrowing: the caller's TYPE PREFIX may itself be mis-cased
  // (`customfield:` for `CustomField:`), and a SQL `type IN (?)` filter is
  // case-SENSITIVE, so narrowing there would re-introduce the very miss this
  // probe exists to catch. The whole id is folded in the filter below instead,
  // which keeps the fold from ever crossing a type boundary.
  const hits = await searchNodes(graph, leaf, { limit: CASE_VARIANT_LIMIT });
  if (!hits.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${hits.error.message}` });
  }
  const folded = componentId.toLowerCase();
  const variants = hits.value
    .map((h) => h.id as string)
    .filter((id) => id.toLowerCase() === folded)
    .sort();
  return ok({
    variants,
    saturated: variants.length === 0 && hits.value.length >= CASE_VARIANT_LIMIT,
  });
};

/**
 * Verbatim refusal when two vault ids differ ONLY by case. Picking one silently
 * is how a reader ends up holding an answer about the other component.
 */
const caseAmbiguityMessage = (componentId: string, ids: readonly string[]): string =>
  `\`${componentId}\` matches ${ids.length} components in this vault that differ only by CASE ` +
  `(${ids.join(', ')}). Salesforce api names are case-insensitive, so nothing here can pick ` +
  'between them — pass the exact `componentId` you mean. No usage answer was computed.';

/**
 * Split a `CustomField` api name into its object and field halves, or null when
 * it is not the `Object.Field` shape the supplemental Flow writer scan needs.
 */
const splitFieldApiName = (
  apiName: string,
): { readonly object: string; readonly field: string } | null => {
  const dot = apiName.indexOf('.');
  if (dot <= 0 || dot === apiName.length - 1) return null;
  return { object: apiName.slice(0, dot), field: apiName.slice(dot + 1) };
};

/**
 * Objects whose CUSTOM fields are ONE physical field: `Activity` is the
 * abstract parent and `Task` / `Event` share its custom field set, so a Flow
 * that writes `Task.Foo__c` really does write `CustomField:Activity.Foo__c`.
 * The graph importer already re-points polymorphic Activity references this way
 * (see `sfi.safe_to_delete_field`'s polymorphic-attribution boundary); the
 * object-scope check below must not undo that by demanding a literal match.
 */
const ACTIVITY_POLYMORPHIC_OBJECTS: ReadonlySet<string> = new Set(['activity', 'task', 'event']);

/** Salesforce object api names are case-insensitive; Activity/Task/Event alias. */
const sameObjectScope = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x === y || (ACTIVITY_POLYMORPHIC_OBJECTS.has(x) && ACTIVITY_POLYMORPHIC_OBJECTS.has(y))
  );
};

/** `<variables>` blocks in a Flow, as SObject variable name → objectType. */
const flowSObjectVariableTypes = (xml: string): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const block = /<variables>([\s\S]*?)<\/variables>/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(xml)) !== null) {
    const b = m[1] ?? '';
    const name = /<name>([^<]+)<\/name>/.exec(b)?.[1];
    const dataType = /<dataType>([^<]+)<\/dataType>/.exec(b)?.[1];
    const objectType = /<objectType>([^<]+)<\/objectType>/.exec(b)?.[1];
    if (name !== undefined && dataType === 'SObject' && objectType !== undefined) {
      out.set(name, objectType);
    }
  }
  return out;
};

/** The object a record-triggered Flow's `$Record` refers to, or null. */
const flowTriggeringObject = (xml: string): string | null => {
  const start = /<start>[\s\S]*?<\/start>/.exec(xml)?.[0];
  if (start === undefined) return null;
  return /<object>([^<]+)<\/object>/.exec(start)?.[1] ?? null;
};

/**
 * Whether an `inputAssignments` writer row really writes THIS object's field.
 *
 * - `scoped`       — some `<recordCreates>`/`<recordUpdates>` that assigns the
 *                    field is resolved to `objectApiName`.
 * - `other-object` — every such DML resolved, and to a DIFFERENT object.
 * - `unresolved`   — at least one such DML's object could not be resolved.
 */
type InputAssignmentsObjectScope = 'scoped' | 'other-object' | 'unresolved';

/**
 * FCU-INPUTASSIGNMENTS-IS-OBJECT-BLIND.
 *
 * `flow-field-writers-scan`'s `inputAssignments` mechanism matches a bare
 * `<field>NAME</field>` inside ANY `<recordCreates>` / `<recordUpdates>`
 * WITHOUT looking at the DML's own `<object>`. The field NAME alone is not an
 * identity: `Name`, `OwnerId`, `Status`, `Description` and `ParentId` exist on
 * nearly every object, and a custom leaf is routinely defined on two. Measured
 * on a real vault, `CustomField:Contract.Name` collected TEN "writers", the
 * first of which contains the string `Contract` zero times (its DML objects are
 * unrelated), and `CustomField:Case.IsVisibleInSelfService` collected a Flow
 * that writes that field on a Task.
 *
 * In `sfi.safe_to_delete_field` that over-match is CONSERVATIVE — a phantom
 * writer yields `blocking`, i.e. "do not delete". Here it points the other way:
 * it would flip `hasStaticEvidence` false→true and DELETE the empty-result
 * coverage caveat, manufacturing a confident "yes, these Flows use it" out of a
 * name collision. So this tool re-derives the enclosing DML's object before it
 * lets an `inputAssignments` row count as evidence.
 *
 * The scoping belongs in `flow-field-writers-scan.ts` itself, where all four
 * callers would inherit it — that module is shared and frozen for this release,
 * so the predicate lives here and the shared-module edit is reported upward.
 * `assignToReference` rows are NOT re-checked: the shared scan already resolves
 * those through the SObject variable's declared `objectType`.
 *
 * Exported for unit tests: the resolution ladder (`<object>` → `$Record` via
 * `<start>` → an SObject `<variables>` entry → unresolved) is the invariant.
 */
/**
 * A Flow's deployed source XML, or `null` when it cannot be read (no node, no
 * `sourcePath` on record, or nothing readable at that path). `null` must never
 * be treated as "checked and clean" — the caller routes it to the
 * object-UNVERIFIED bucket, not to the confirmed one.
 */
const readFlowSource = async (ctx: Context, flowId: ComponentId): Promise<string | null> => {
  const node = await getNodeById(ctx.graph, flowId);
  if (!node.ok || node.value === null) return null;
  const sourcePath = node.value.sourcePath;
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return null;
  try {
    return await readFile(join(ctx.vaultRoot, sourcePath), 'utf-8');
  } catch {
    return null;
  }
};

export const classifyInputAssignmentsObjectScope = (
  xml: string,
  objectApiName: string,
  fieldApiName: string,
): InputAssignmentsObjectScope => {
  const escaped = fieldApiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTag = new RegExp(`<field>${escaped}</field>`);
  const sobjectVars = flowSObjectVariableTypes(xml);
  const triggering = flowTriggeringObject(xml);
  let sawUnresolved = false;
  let sawAssigning = false;
  for (const tag of ['recordCreates', 'recordUpdates'] as const) {
    const dmlPattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    let dml: RegExpExecArray | null;
    while ((dml = dmlPattern.exec(xml)) !== null) {
      const blk = dml[0];
      let assignsField = false;
      const iaPattern = /<inputAssignments>[\s\S]*?<\/inputAssignments>/g;
      let ia: RegExpExecArray | null;
      while ((ia = iaPattern.exec(blk)) !== null) {
        if (fieldTag.test(ia[0])) {
          assignsField = true;
          break;
        }
      }
      if (!assignsField) continue;
      sawAssigning = true;
      const declared = /<object>([^<]+)<\/object>/.exec(blk)?.[1];
      if (declared !== undefined) {
        if (sameObjectScope(declared, objectApiName)) return 'scoped';
        continue;
      }
      const ref = /<inputReference>([^<]+)<\/inputReference>/.exec(blk)?.[1];
      if (ref === undefined) {
        sawUnresolved = true;
        continue;
      }
      const head = ref.split('.')[0] ?? '';
      const resolved = head === '$Record' ? triggering : (sobjectVars.get(head) ?? null);
      if (resolved === null) {
        sawUnresolved = true;
        continue;
      }
      if (sameObjectScope(resolved, objectApiName)) return 'scoped';
    }
  }
  if (sawUnresolved) return 'unresolved';
  // No assigning DML at all means the shared scan and this re-derivation
  // disagree about the source — treat that as unresolved, never as a clean
  // "different object", so an unexplained disagreement can never certify.
  return sawAssigning ? 'other-object' : 'unresolved';
};

/**
 * True when a grep match is the component's OWN definition rather than
 * evidence that something ELSE uses it (FIND-COMPONENT-USAGES-SELF-MATCH): a
 * class's `class Foo {` declaration line matches a grep for `Foo` just like a
 * real caller would, so an otherwise-unreferenced component reported
 * `hasStaticEvidence: true` off nothing but its own declaration — measured on
 * a real vault, an ApexClass with ZERO graph referrers and `grepMatchCount: 1`
 * where the one match WAS its own `public class …` line.
 *
 * Two shapes of "own definition":
 *   1. A single-file component (ApexClass `.cls`, ApexTrigger `.trigger`) —
 *      the match's path is EXACTLY the node's own `sourcePath`.
 *   2. A BUNDLE component (LWC / Aura) whose `sourcePath` sits inside its own
 *      bundle directory — ANY file in that SAME directory is still the
 *      component's own definition (a `.js` controller matching its own `.html`
 *      template's tag name is not a caller either), so the whole directory is
 *      excluded. Gated via {@link BUNDLE_DIR_RE}, NOT the broader frontend
 *      pattern.
 *   3. A FLAT frontend component (Visualforce `pages/` and `components/`) whose
 *      directory holds EVERY component of its type. Here only the same
 *      api-name stem is the component's own definition — `Foo.page` and
 *      `Foo.page-meta.xml` — while `Bar.page` next to it is a different
 *      component and a legitimate caller.
 *
 * Case 3 previously fell into case 2, because one pattern was deciding both
 * "is this a frontend directory worth grepping" and "is this a bundle". Every
 * real Visualforce caller was discarded as a self-match and the tool reported
 * no static evidence — the fix for over-counting had produced an under-count,
 * in the tool people consult before deleting things.
 */
const isSelfMatch = (matchPath: string, ownSourcePath: string): boolean => {
  if (matchPath === ownSourcePath) return true;
  const bundleDir = bundleDirOf(ownSourcePath);
  if (bundleDir !== null) return matchPath.startsWith(bundleDir);
  const ownDir = ownSourcePath.slice(0, ownSourcePath.lastIndexOf('/') + 1);
  if (ownDir.length === 0) return false;
  if (FRONTEND_DIR_RE.test(ownSourcePath)) {
    return (
      matchPath.startsWith(ownDir) &&
      basenameStem(matchPath) === basenameStem(ownSourcePath)
    );
  }
  return false;
};

export const findComponentUsagesHandler = async (
  ctx: Context,
  input: FindComponentUsagesInput,
): Promise<Result<McpResponse<FindComponentUsagesOutput>, McpError>> => {
  const requestedId = input.componentId;
  if (!requestedId.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a canonical id (\`Type:Name\`); got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  // The node may be a phantom (referenced but not retrieved) — that is fine for a
  // usage query; we still answer from its incoming edges.
  const nodeRes = await getNodeById(ctx.graph, requestedId as ComponentId);
  if (!nodeRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
  }
  let node: Node | null = nodeRes.value;

  // FCU-WRONG-CASE-ID-READS-AS-ABSENT: the exactly-cased id missed, so before
  // refusing, ask whether the vault spells this same api name differently.
  // Salesforce api names are case-insensitive; a spreadsheet-cased name is not
  // a different component. Runs ONLY on the path that was about to fail, and
  // only for a NON-phantom miss is the id rewritten — a phantom (no node, real
  // incoming edges) keeps its exact id because the edges are keyed by it.
  let resolvedFrom: string | null = null;
  let caseProbeSaturated = false;
  let componentId = requestedId as ComponentId;
  if (node === null) {
    const probe = await idCaseVariants(ctx.graph, requestedId);
    if (!probe.ok) return probe;
    caseProbeSaturated = probe.value.saturated;
    if (probe.value.variants.length > 1) {
      // Case-insensitive RESOLUTION must never become case-insensitive
      // IDENTITY — refuse by NAME rather than silently answer about one of them.
      return err({
        kind: 'invalid-query',
        message: caseAmbiguityMessage(requestedId, probe.value.variants),
        path: 'componentId',
      });
    }
    const only = probe.value.variants[0];
    if (only !== undefined) {
      componentId = only as ComponentId;
      resolvedFrom = requestedId;
      const reRead = await getNodeById(ctx.graph, componentId);
      if (!reRead.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${reRead.error.message}` });
      }
      node = reRead.value;
    }
  }
  // Both halves come from the RESOLVED id: a mis-cased type prefix must not
  // leak into the type-driven behaviour below (the CustomField writer scan, the
  // CustomPermission grant section, the per-type empty notes).
  const targetType = typeOf(componentId);
  const targetApiName = apiNameOf(componentId);
  const retrieved = node !== null;

  // --- GRAPH tier: incoming usage edges (minus access + structural). ---
  const edgesRes = await listEdges(ctx.graph, componentId, { direction: 'in' });
  if (!edgesRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesRes.error.message}` });
  }
  const incomingEdges = edgesRes.value as readonly Edge[];
  const usageEdges = incomingEdges.filter((e) => !NON_USAGE_EDGE_TYPES.has(e.edgeType));
  // Grant edges are kept ASIDE (never in the usage tier): a CustomPermission's
  // only incoming edges are grants, and a zero-usage-but-granted target must
  // stay answerable — surfaced in the separate `grantedBy` section below.
  const grantEdges = incomingEdges.filter((e) => e.edgeType === 'grantedBy');

  const byType = new Map<string, GraphReferrer[]>();
  for (const e of usageEdges) {
    const rt = typeOf(e.fromId);
    const list = byType.get(rt) ?? [];
    list.push({ referrerId: e.fromId, viaEdge: e.edgeType, confidence: e.confidence });
    byType.set(rt, list);
  }
  const graphReferrers: ReferrerGroup[] = [...byType.entries()]
    .map(([referrerType, refs]) => ({
      referrerType,
      count: refs.length,
      // A referrer with several relationships to the target (a Flow that reads,
      // writes AND triggers on an object) contributes several EDGES but is ONE
      // component. `count` alone read as "77 flows use this" over-stated a real
      // hub by 45%.
      distinctReferrers: new Set(refs.map((r) => r.referrerId)).size,
      sample: refs
        .sort((a, b) => (a.referrerId < b.referrerId ? -1 : a.referrerId > b.referrerId ? 1 : 0))
        .slice(0, GRAPH_REFERRER_SAMPLE),
    }))
    .sort((a, b) => b.count - a.count || (a.referrerType < b.referrerType ? -1 : 1));
  const graphReferrerCount = usageEdges.length;
  const distinctReferrerCount = new Set(usageEdges.map((e) => e.fromId)).size;
  const graphTruncated = graphReferrers.some((g) => g.count > g.sample.length);

  // --- GREP supplement: literal api-name match in Apex AND frontend bundle
  // source (text-match tier). The frontend pass (LWC/Aura/VF) fills whatever
  // budget the Apex pass left — $Label / $Resource / @salesforce module
  // references are invisible to an Apex-only walk (P14-USAGE-grep-frontend).
  const runGrep = input.includeGrep !== false;
  let grepRan = false;
  let grepMatches: { path: string; line: number; snippet: string }[] = [];
  let grepTruncated = false;
  if (runGrep && targetApiName.length >= 3) {
    const grepLimit = input.grepLimit ?? GREP_LIMIT_DEFAULT;
    const gr = await searchApexSourceHandler(ctx, { query: targetApiName, limit: grepLimit });
    if (gr.ok) {
      grepRan = true;
      grepMatches = (gr.value.data.matches ?? []).map((m) => ({
        path: m.path,
        line: m.line,
        snippet: m.snippet,
      }));
      grepTruncated = gr.value.data.truncated === true;
    }
    const frontendBudget = grepLimit - grepMatches.length;
    if (frontendBudget > 0) {
      const fr = await grepVaultSource(ctx, {
        query: targetApiName,
        limit: frontendBudget,
        suffixes: FRONTEND_SUFFIXES,
        pathFilter: (p) => FRONTEND_DIR_RE.test(p),
      });
      if (fr.ok) {
        grepRan = true;
        grepMatches.push(
          ...fr.value.matches.map((m) => ({ path: m.path, line: m.line, snippet: m.snippet })),
        );
        grepTruncated = grepTruncated || fr.value.truncated;
      }
    }
  }

  // FIND-COMPONENT-USAGES-SELF-MATCH: a component's own declaration/bundle
  // matches its own name just like a real caller's reference would — exclude
  // it BEFORE grepMatchCount / hasStaticEvidence are computed, so a component
  // with zero real referrers cannot report static evidence of its own usage.
  let selfMatchesExcluded = 0;
  if (node !== null) {
    const before = grepMatches.length;
    grepMatches = grepMatches.filter((m) => !isSelfMatch(m.path, node.sourcePath));
    selfMatchesExcluded = before - grepMatches.length;
  }

  // --- SUPPLEMENTAL FLOW-WRITER tier (FCU-FLOW-FIELD-WRITERS-UNCONSULTED).
  // A Flow field write routed through an SObject variable / a recordCreates or
  // recordUpdates `<inputAssignments>` block mints NO `writesTo` edge, and the
  // grep tier searches the QUALIFIED `Object.Field` string that Flow XML never
  // contains — so BOTH tiers above are structurally blind to it. Run the SAME
  // shared scan `safe_to_delete_field` / `field_360` / `why_field_changed`
  // already run, rather than adding a fourth private copy. Gated to the only
  // shape where it decides the answer — a `CustomField` whose graph usage tier
  // is EMPTY — so the full Flow source walk is paid exactly where the tool was
  // otherwise about to narrate an unchecked absence.
  const fieldParts = targetType === 'CustomField' ? splitFieldApiName(targetApiName) : null;
  const runFlowWriterScan = fieldParts !== null && usageEdges.length === 0;
  const flowWriterScan = runFlowWriterScan
    ? await scanSupplementalFlowFieldWriters(ctx, fieldParts.object, fieldParts.field)
    : null;
  // FCU-INPUTASSIGNMENTS-IS-OBJECT-BLIND: the shared scan's `inputAssignments`
  // mechanism matches a bare `<field>NAME</field>` in ANY DML without checking
  // that DML's own object, so a same-named field on another object arrives here
  // as a "writer". Re-derive the object for exactly those rows before letting
  // any of them count as evidence. `assignToReference` rows are already
  // object-resolved by the shared scan (through the SObject variable's declared
  // `objectType`) and are taken as-is.
  const confirmedWriters: SupplementalFlowFieldWriter[] = [];
  const unverifiedWriters: SupplementalFlowFieldWriter[] = [];
  let otherObjectMatchesDropped = 0;
  if (flowWriterScan !== null && fieldParts !== null) {
    for (const w of flowWriterScan.writers) {
      if (w.mechanism !== 'inputAssignments') {
        confirmedWriters.push(w);
        continue;
      }
      const xml = await readFlowSource(ctx, w.componentId);
      if (xml === null) {
        // Source unreadable at re-derivation time — the object could not be
        // checked, so this row is a LEAD, never confirmed evidence.
        unverifiedWriters.push(w);
        continue;
      }
      const scope = classifyInputAssignmentsObjectScope(xml, fieldParts.object, fieldParts.field);
      if (scope === 'scoped') confirmedWriters.push(w);
      else if (scope === 'unresolved') unverifiedWriters.push(w);
      else otherObjectMatchesDropped += 1;
    }
  }
  const distinctOf = (rows: readonly SupplementalFlowFieldWriter[]): number =>
    new Set(rows.map((r) => r.componentId)).size;
  const toRow = (w: SupplementalFlowFieldWriter): {
    flowId: ComponentId;
    apiName: string;
    mechanism: SupplementalFlowFieldWriter['mechanism'];
  } => ({ flowId: w.componentId, apiName: w.apiName, mechanism: w.mechanism });

  let supplementalFlowWriters: SupplementalFlowWritersSection | undefined;
  if (flowWriterScan !== null) {
    const confirmedSample = confirmedWriters.slice(0, GRAPH_REFERRER_SAMPLE);
    const unverifiedSample = unverifiedWriters.slice(0, GRAPH_REFERRER_SAMPLE);
    supplementalFlowWriters = {
      tier: 'source-scan',
      writers: confirmedSample.map(toRow),
      count: confirmedWriters.length,
      distinctWriters: distinctOf(confirmedWriters),
      scannedFlows: flowWriterScan.scannedCount,
      totalFlows: flowWriterScan.totalCount,
      truncated: flowWriterScan.truncated,
      truncationCause: flowWriterScan.truncationCause,
      sampleTruncated:
        confirmedWriters.length > confirmedSample.length ||
        unverifiedWriters.length > unverifiedSample.length,
      objectUnverified: {
        writers: unverifiedSample.map(toRow),
        count: unverifiedWriters.length,
        distinctWriters: distinctOf(unverifiedWriters),
      },
      otherObjectMatchesDropped,
    };
  }
  // TYPED ABSENCE: a bare 0 would read as "scanned every Flow, found none"
  // whether or not anything was scanned. `null` = NOT CHECKED — the tier did
  // not apply, or it ran and could not prove its zero.
  const supplementalFlowWriterCount =
    flowWriterScan === null || (flowWriterScan.truncated && confirmedWriters.length === 0)
      ? null
      : distinctOf(confirmedWriters);

  const hasStaticEvidence =
    graphReferrerCount > 0 || grepMatches.length > 0 || confirmedWriters.length > 0;

  // Access-grant section (grants are NOT usage, so they never count as static
  // evidence): always present for a CustomPermission (an explicit count of 0
  // means "no container grants it in this vault"), and for any other target
  // only when it has zero usage edges but IS granted — otherwise absent.
  const surfaceGrants =
    targetType === 'CustomPermission' || (usageEdges.length === 0 && grantEdges.length > 0);
  let grantedBySection: GrantedBySection | undefined;
  if (surfaceGrants) {
    const granterIds = [...new Set(grantEdges.map((e) => e.fromId))].sort();
    grantedBySection = {
      count: granterIds.length,
      granters: granterIds
        .slice(0, GRAPH_REFERRER_SAMPLE)
        .map((id) => ({ id, type: typeOf(id) })),
    };
  }

  // Unknown target with NO evidence anywhere → genuinely not found. A grant
  // edge counts as existence here: a granted-but-not-retrieved CustomPermission
  // (managed-package) must answer from its grants, not vanish.
  if (!retrieved && graphReferrerCount === 0 && !hasStaticEvidence && grantEdges.length === 0) {
    return err({
      kind: 'component-not-found',
      message:
        `no component or referrer matches \`${componentId}\` in this vault` +
        (caseProbeSaturated
          ? ' — and the CASE-insensitive probe was INCONCLUSIVE: too many components ' +
            `share this leaf name to enumerate (the probe reads at most ${CASE_VARIANT_LIMIT}), ` +
            'so a differently-cased match cannot be ruled out. Pass the exact `componentId` ' +
            '(`sfi.resolve` will give it).'
          : ' — including a CASE-insensitive match on the api name, so this is NOT a casing ' +
            'mismatch. The name may be mis-typed, or the vault may predate the component ' +
            '(`sfi refresh`).'),
      path: componentId,
    });
  }

  const boundaries: string[] = [
    'Graph referrers are the modeled incoming dependency edges (access grants `grantedBy` and structural `parentOf` are EXCLUDED — access is not usage); each carries edge `confidence` (declared / parsed / heuristic).',
    `\`graphReferrerCount\` and each group's \`count\` are EDGE counts, not component counts: one referrer contributes one edge per relationship it has to the target (a Flow that reads, writes AND triggers on an object counts 3). ${graphReferrerCount} edge(s) here come from ${distinctReferrerCount} distinct component(s) — quote \`distinctReferrerCount\` / \`distinctReferrers\` to a human, and note the 25-row \`sample\` cap is on ROWS, so a group with multi-edge referrers shows fewer than 25 distinct components.`,
    'The grep supplement is a literal text match on the api name across Apex AND frontend bundle source — LWC, Aura, Visualforce ($Label / $Resource / @salesforce module references) — (`text-match` tier): it can OVER-match (a substring / a different component sharing the name) and UNDER-match (dynamically built references). Treat it as leads, not proof.',
  ];
  // FCU-WRONG-CASE-ID-READS-AS-ABSENT: the answer is about a DIFFERENT id than
  // the caller passed. Say so, and echo the vault's exact casing.
  if (resolvedFrom !== null) {
    boundaries.push(
      `The requested id \`${resolvedFrom}\` does not exist in this vault with that CASING; Salesforce api names are case-insensitive, so it was resolved to the vault's exact spelling \`${componentId}\` and THAT is what this answer describes. Quote \`target.componentId\`, never the id you passed.`,
    );
  }
  // A CustomField's grep query is the QUALIFIED `Object.Field__c` string, which
  // is not how a reference is usually spelled: Apex writes `record.Field__c`,
  // LWC writes `Object.Field__c` only inside a `@salesforce/schema` import, and
  // Flow XML never writes it at all. So `grepMatchCount: 0` on a field is a
  // WEAK zero, and a host quoting it next to an empty graph tier as if the two
  // corroborated each other is reading agreement into one tier that never
  // looked. Say which string was searched, in prose, beside the number.
  if (targetType === 'CustomField' && grepRan && grepMatches.length === 0) {
    boundaries.push(
      `The grep tier searched the QUALIFIED string \`${targetApiName}\` — the form Apex (\`record.${targetApiName.slice(targetApiName.lastIndexOf('.') + 1)}\`), LWC and Flow XML mostly do NOT spell — so its 0 matches are WEAK evidence of absence, not a second independent confirmation of the empty graph tier.`,
    );
  }
  // FCU-FLOW-FIELD-WRITERS-UNCONSULTED: say what the third tier did, in prose,
  // next to the numbers — and never let the empty-result coverage caveat below
  // read as though the un-retrieved analytics families were the ONLY way this
  // answer could be a false empty.
  if (supplementalFlowWriters !== undefined && flowWriterScan !== null) {
    const u = supplementalFlowWriters.objectUnverified;
    if (supplementalFlowWriters.count > 0) {
      boundaries.push(
        `${supplementalFlowWriters.distinctWriters} Flow(s) write this field through a path that mints no graph edge — an SObject-variable \`<assignToReference>\`, or a \`<recordCreates>\`/\`<recordUpdates>\` \`<inputAssignments>\` block whose own \`<object>\`/\`<inputReference>\` RESOLVES TO \`${fieldParts?.object ?? targetApiName}\` — reconstructed from Flow source by \`flow-field-writers-scan\` (the same scan \`sfi.safe_to_delete_field\` runs per field), across ${supplementalFlowWriters.count} write site(s): \`count\` is a ROW count, \`distinctWriters\` is the Flow count. This is still SOURCE PATTERN MATCHING, not an execution proof, and it does NOT partition Active automation from Obsolete/Draft Flows — use \`sfi.safe_to_delete_field\` or \`sfi.why_field_changed\` for the runnable/status split before acting.`,
      );
    } else if (u.count === 0 && !supplementalFlowWriters.truncated) {
      boundaries.push(
        `The Flow field-writer plane WAS checked for this field: \`flow-field-writers-scan\` read ${supplementalFlowWriters.scannedFlows} of ${supplementalFlowWriters.totalFlows} Flow source file(s) and found no SObject-variable \`<assignToReference>\` or object-scoped \`<inputAssignments>\` write to it. That zero is a CHECKED zero — neither the graph tier (such writes mint no \`writesTo\` edge) nor the grep tier (it searches the qualified \`Object.Field\` string, which Flow XML never contains) can see this plane on their own.`,
      );
    }
    if (u.count > 0) {
      boundaries.push(
        `\`supplementalFlowWriters.objectUnverified\` holds ${u.count} name-only match(es) in ${u.distinctWriters} Flow(s): the shared scan matches an \`<inputAssignments>\` \`<field>\` tag on the FIELD NAME ALONE, WITHOUT checking the enclosing DML's object, so a same-named field on a DIFFERENT object produces a false writer. For these rows the enclosing \`<recordCreates>\`/\`<recordUpdates>\` object could not be resolved from source, so it is UNKNOWN whether they touch \`${fieldParts?.object ?? targetApiName}\` at all. They are LEADS: they do NOT set \`hasStaticEvidence\` and do NOT suppress \`coverageCaveat\`. Read the Flow to confirm.`,
      );
    }
    if (supplementalFlowWriters.otherObjectMatchesDropped > 0) {
      boundaries.push(
        `${supplementalFlowWriters.otherObjectMatchesDropped} further Flow(s) assign a field named \`${fieldParts?.field ?? targetApiName}\` in a \`<recordCreates>\`/\`<recordUpdates>\` that resolves to a DIFFERENT object, and were DROPPED as same-name collisions rather than reported as writers. \`sfi.safe_to_delete_field\` does not apply this object scoping, so it may name them — there a phantom writer only makes the verdict more conservative, whereas here it would manufacture evidence.`,
      );
    }
    if (supplementalFlowWriters.sampleTruncated) {
      boundaries.push(
        `The Flow-writer row lists are SAMPLES capped at ${GRAPH_REFERRER_SAMPLE} rows — \`count\` / \`objectUnverified.count\` are the true totals and the payload-level \`truncated\` is set.`,
      );
    }
    const scanBoundary = describeSupplementalFlowWriterScanBoundary(flowWriterScan);
    if (scanBoundary !== null) boundaries.push(scanBoundary);
  }
  // FIND-COMPONENT-USAGES-SELF-MATCH: say plainly WHY a raw grep count and
  // the reported `grepMatchCount` differ, so "grep ran and found only its own
  // declaration" (selfMatchesExcluded > 0, matchCount possibly 0) is never
  // read as identical to "grep did not run" (`ran: false`) or an unqualified
  // zero.
  if (selfMatchesExcluded > 0) {
    boundaries.push(
      `${selfMatchesExcluded} grep match(es) were this component's OWN definition (its declaring file${
        bundleDirOf(node?.sourcePath ?? '') !== null ? ' / bundle directory' : ''
      }) and were EXCLUDED before \`grepMatchCount\` — a component's own declaration matching its own name is not evidence anything ELSE uses it. ${
        grepMatches.length === 0
          ? 'After exclusion, grep found NO other reference.'
          : `After exclusion, ${grepMatches.length} genuine external match(es) remain.`
      }`,
    );
  }
  // I3b (empty ≠ none): only when there is NO static evidence anywhere do we
  // risk narrating absence as fact — name the dependency families the vault did
  // NOT fully retrieve so "nothing uses this" carries "…among the families the
  // vault covers". Non-empty answers are untouched.
  const coverageCaveat = !hasStaticEvidence
    ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE)
    : undefined;
  if (!hasStaticEvidence) {
    boundaries.push(
      'No static evidence of usage found in this vault — this is NOT proof that nothing uses it. Dynamic SOQL / reflective access, references from un-modeled families (reports, dashboards, list-view filters, custom-metadata-driven config), and managed packages are invisible to static analysis.',
    );
    if (coverageCaveat !== undefined) boundaries.push(coverageCaveat.message);
    const typeNote = TYPE_EMPTY_NOTES[targetType];
    if (typeNote !== undefined) boundaries.push(typeNote);
  }
  if (GREP_RELIANT_PREFIXES.has(targetType)) {
    boundaries.push(
      `${targetType} usage has a weaker graph tier — FRONTEND references ($Label / $Resource / $Setup and @salesforce imports in LWC/Aura/Visualforce) are modeled as graph edges on vaults refreshed at 0.1.10+, but Apex references (System.Label.X, dynamic config reads) are still grep-only, so the grep supplement carries part of the answer here. Confirm by reading the matched source.`,
    );
  }
  if (grantedBySection !== undefined) {
    boundaries.push(
      `Access grants are listed SEPARATELY in \`grantedBy\` (${grantedBySection.count} granting container(s)) — a grant is ACCESS, not usage, so granters never appear in graphReferrers. For a CustomPermission this answers "which Profiles / PermissionSets grant it?"; checking a custom permission in code (FeatureManagement / $Permission) is usage and stays in the usage tiers.`,
    );
  }
  if (!retrieved) {
    boundaries.push(
      'This component is a PHANTOM — referenced by the edges below but NOT retrieved into the vault, so its own definition is unavailable; the referrer list is still valid.',
    );
  }

  return ok({
    data: {
      target: { componentId, type: targetType, apiName: targetApiName, retrieved, resolvedFrom },
      graphReferrers,
      ...(grantedBySection !== undefined ? { grantedBy: grantedBySection } : {}),
      ...(supplementalFlowWriters !== undefined ? { supplementalFlowWriters } : {}),
      grepSupplement: {
        tier: 'text-match',
        ran: grepRan,
        query: grepRan ? targetApiName : null,
        matchCount: grepMatches.length,
        matches: grepMatches,
        truncated: grepTruncated,
        selfMatchesExcluded,
      },
      summary: {
        graphReferrerCount,
        distinctReferrerCount,
        grepMatchCount: grepMatches.length,
        supplementalFlowWriterCount,
        supplementalFlowWriterUnverifiedCount:
          supplementalFlowWriterCount === null ? null : distinctOf(unverifiedWriters),
        referrerTypes: graphReferrers.map((g) => g.referrerType),
        hasStaticEvidence,
      },
      boundaries,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      // Every tier's incompleteness folds into ONE payload flag: the graph
      // sample cap, the grep tier, the Flow-writer scan's own truncation AND
      // its row-sample cap. A caller that reads only this boolean must never be
      // told the answer is complete while a list underneath it is short.
      truncated:
        graphTruncated ||
        grepTruncated ||
        (flowWriterScan?.truncated ?? false) ||
        (supplementalFlowWriters?.sampleTruncated ?? false),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
