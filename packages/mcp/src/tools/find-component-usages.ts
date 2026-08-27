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
import type { ComponentId, Edge, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import { grepVaultSource, searchApexSourceHandler } from './search-apex-source.js';

/** Incoming edge types that are NOT usage — access grants + structural parentage. */
const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(['grantedBy', 'parentOf']);

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
 */
const BUNDLE_DIR_RE = /\/(lwc|aura)\//;

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

export interface FindComponentUsagesOutput {
  readonly target: { readonly componentId: ComponentId; readonly type: string; readonly apiName: string; readonly retrieved: boolean };
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
  const ownDir = ownSourcePath.slice(0, ownSourcePath.lastIndexOf('/') + 1);
  if (ownDir.length === 0) return false;
  if (BUNDLE_DIR_RE.test(ownSourcePath)) return matchPath.startsWith(ownDir);
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
  const componentId = input.componentId as ComponentId;
  if (!componentId.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a canonical id (\`Type:Name\`); got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const targetType = typeOf(componentId);
  const targetApiName = apiNameOf(componentId);

  // The node may be a phantom (referenced but not retrieved) — that is fine for a
  // usage query; we still answer from its incoming edges.
  const nodeRes = await getNodeById(ctx.graph, componentId);
  if (!nodeRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
  }
  const node: Node | null = nodeRes.value;
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

  const hasStaticEvidence = graphReferrerCount > 0 || grepMatches.length > 0;

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
      message: `no component or referrer matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }

  const boundaries: string[] = [
    'Graph referrers are the modeled incoming dependency edges (access grants `grantedBy` and structural `parentOf` are EXCLUDED — access is not usage); each carries edge `confidence` (declared / parsed / heuristic).',
    `\`graphReferrerCount\` and each group's \`count\` are EDGE counts, not component counts: one referrer contributes one edge per relationship it has to the target (a Flow that reads, writes AND triggers on an object counts 3). ${graphReferrerCount} edge(s) here come from ${distinctReferrerCount} distinct component(s) — quote \`distinctReferrerCount\` / \`distinctReferrers\` to a human, and note the 25-row \`sample\` cap is on ROWS, so a group with multi-edge referrers shows fewer than 25 distinct components.`,
    'The grep supplement is a literal text match on the api name across Apex AND frontend bundle source — LWC, Aura, Visualforce ($Label / $Resource / @salesforce module references) — (`text-match` tier): it can OVER-match (a substring / a different component sharing the name) and UNDER-match (dynamically built references). Treat it as leads, not proof.',
  ];
  // FIND-COMPONENT-USAGES-SELF-MATCH: say plainly WHY a raw grep count and
  // the reported `grepMatchCount` differ, so "grep ran and found only its own
  // declaration" (selfMatchesExcluded > 0, matchCount possibly 0) is never
  // read as identical to "grep did not run" (`ran: false`) or an unqualified
  // zero.
  if (selfMatchesExcluded > 0) {
    boundaries.push(
      `${selfMatchesExcluded} grep match(es) were this component's OWN definition (its declaring file${
        FRONTEND_DIR_RE.test(node?.sourcePath ?? '') ? ' / bundle directory' : ''
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
      target: { componentId, type: targetType, apiName: targetApiName, retrieved },
      graphReferrers,
      ...(grantedBySection !== undefined ? { grantedBy: grantedBySection } : {}),
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
        referrerTypes: graphReferrers.map((g) => g.referrerType),
        hasStaticEvidence,
      },
      boundaries,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      truncated: graphTruncated || grepTruncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
