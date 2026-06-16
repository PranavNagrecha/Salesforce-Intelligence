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
 */
import type { ComponentId, Edge, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

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
  readonly count: number;
  readonly sample: readonly GraphReferrer[];
}

export interface FindComponentUsagesOutput {
  readonly target: { readonly componentId: ComponentId; readonly type: string; readonly apiName: string; readonly retrieved: boolean };
  readonly graphReferrers: readonly ReferrerGroup[];
  readonly grepSupplement: {
    readonly tier: 'text-match';
    readonly ran: boolean;
    readonly query: string | null;
    readonly matchCount: number;
    readonly matches: readonly { readonly path: string; readonly line: number; readonly snippet: string }[];
    readonly truncated: boolean;
  };
  readonly summary: {
    readonly graphReferrerCount: number;
    readonly grepMatchCount: number;
    readonly referrerTypes: readonly string[];
    readonly hasStaticEvidence: boolean;
  };
  readonly boundaries: readonly string[];
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
  const usageEdges = (edgesRes.value as readonly Edge[]).filter((e) => !NON_USAGE_EDGE_TYPES.has(e.edgeType));

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
      sample: refs
        .sort((a, b) => (a.referrerId < b.referrerId ? -1 : a.referrerId > b.referrerId ? 1 : 0))
        .slice(0, GRAPH_REFERRER_SAMPLE),
    }))
    .sort((a, b) => b.count - a.count || (a.referrerType < b.referrerType ? -1 : 1));
  const graphReferrerCount = usageEdges.length;
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

  const hasStaticEvidence = graphReferrerCount > 0 || grepMatches.length > 0;

  // Unknown target with NO evidence anywhere → genuinely not found.
  if (!retrieved && graphReferrerCount === 0 && !hasStaticEvidence) {
    return err({
      kind: 'component-not-found',
      message: `no component or referrer matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }

  const boundaries: string[] = [
    'Graph referrers are the modeled incoming dependency edges (access grants `grantedBy` and structural `parentOf` are EXCLUDED — access is not usage); each carries edge `confidence` (declared / parsed / heuristic).',
    'The grep supplement is a literal text match on the api name across Apex AND frontend bundle source — LWC, Aura, Visualforce ($Label / $Resource / @salesforce module references) — (`text-match` tier): it can OVER-match (a substring / a different component sharing the name) and UNDER-match (dynamically built references). Treat it as leads, not proof.',
  ];
  if (!hasStaticEvidence) {
    boundaries.push(
      'No static evidence of usage found in this vault — this is NOT proof that nothing uses it. Dynamic SOQL / reflective access, references from un-modeled families (reports, dashboards, list-view filters, custom-metadata-driven config), and managed packages are invisible to static analysis.',
    );
    const typeNote = TYPE_EMPTY_NOTES[targetType];
    if (typeNote !== undefined) boundaries.push(typeNote);
  }
  if (GREP_RELIANT_PREFIXES.has(targetType)) {
    boundaries.push(
      `${targetType} usage has a weaker graph tier — FRONTEND references ($Label / $Resource / $Setup and @salesforce imports in LWC/Aura/Visualforce) are modeled as graph edges on vaults refreshed at 0.1.10+, but Apex references (System.Label.X, dynamic config reads) are still grep-only, so the grep supplement carries part of the answer here. Confirm by reading the matched source.`,
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
      grepSupplement: {
        tier: 'text-match',
        ran: grepRan,
        query: grepRan ? targetApiName : null,
        matchCount: grepMatches.length,
        matches: grepMatches,
        truncated: grepTruncated,
      },
      summary: {
        graphReferrerCount,
        grepMatchCount: grepMatches.length,
        referrerTypes: graphReferrers.map((g) => g.referrerType),
        hasStaticEvidence,
      },
      boundaries,
      truncated: graphTruncated || grepTruncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
