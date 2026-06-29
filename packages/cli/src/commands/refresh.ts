import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  ComponentId,
  CoverageEntry,
  ComponentType,
  EdgeType,
  ExtractionResult,
  Node,
  PhantomClassification,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  buildDescribeFieldExtraction,
  existingCustomFieldIds,
  existingCustomFieldNodes,
  mergeDescribeFieldSnapshots,
  STANDARD_OBJECT_FIELD_SNAPSHOT,
} from '@sf-intelligence/extractors';
import {
  applyChangeSet,
  type ApplyCounts,
  changeSetSize,
  classifyPhantom,
  closeGraph,
  computePhantomBucketSummary,
  computeChangeSet,
  copyFacts,
  type CoverageStatus,
  getNodeById,
  type GraphError,
  importExtractionResults,
  type ImportCounts,
  INCREMENTAL_DELTA_CAP,
  persistResolveIndexArtifact,
  listEdges,
  listNodesByType,
  openGraph,
  openGraphReadOnly,
  pruneStaleNodes,
  type GraphStore,
} from '@sf-intelligence/graph';
import { dispatchTool, runSfJson, type Context as McpContext } from '@sf-intelligence/mcp';
import { recognizeNamingConventions } from '@sf-intelligence/patterns';
import { renderOrgCard, serializeFrontmatter } from '@sf-intelligence/renderers';
import {
  createToolingApiClient,
  enrichLastModified,
  getAuthFromSfCli,
  type EnrichmentResult,
  type ToolingApiClient,
} from '@sf-intelligence/tooling-api';
import {
  appendDrainResult,
  buildCoverageEntries as manifestCoverageEntries,
  computeSourceTreeHash,
  loadManifest,
  queuedDrainIds,
  readAnnotations,
  readDemandQueue,
  saveManifest,
  vaultPaths,
  type ExtendedVaultManifest,
  type StagedBuildMarker,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

import { captureDataShape } from '../data-shape-capture.js';
import { buildOrgCardInput } from '../org-card-input.js';
import { readCliPackageVersion } from '../package-version.js';
import {
  foldReportDashboardUsageIntoFields,
  parseTypeFilter,
  renderVault,
  SUPPORTED_TYPES,
  walkAndExtract,
  componentTypeFromSourcePath,
  EXTRACT_CACHE_VERSION,
  type ExtractCache,
  type RefreshExtractionFailure,
} from '../refresh-pipeline.js';
import {
  reconcileSourceDeletions,
  syncAuthoritativeRetrieveIntoSource,
} from '../source-reconcile.js';

import { ORG_ALIAS_RE, validateOrgAlias } from './org-alias.js';
import { assessRefreshSize } from './refresh-preflight.js';
import { runSnapshotCreate } from './snapshot.js';

const execFileAsync = promisify(execFile);
/** Default Salesforce metadata API version stamped into the generated package.xml. */
const SF_API_VERSION = '62.0';

/** Pipeline status. `success` = clean. `partial` = per-file extractor failures but vault coherent. `failed` = fatal step aborted. */
export type RefreshStatus = 'success' | 'partial' | 'failed';

/** Outcome of a refresh run. Shared between tests and the CLI handler. */
export interface RefreshResult {
  readonly status: RefreshStatus;
  readonly counts: {
    readonly components: Readonly<Partial<Record<ComponentType, number>>>;
    readonly edges: Readonly<Partial<Record<EdgeType, number>>>;
  };
  readonly errors: readonly RefreshExtractionFailure[];
  readonly durationMs: number;
  /** Populated only on `status: 'failed'`. */
  readonly fatalError?: string;
  /**
   * Metadata types the retrieve could not deliver this run (a type the org
   * exposes but that failed mid-pull — e.g. an OmniStudio/PSS type). Non-empty
   * forces `status: 'partial'`: the vault was built from what landed, with these
   * types skipped rather than aborting the whole refresh. Absent on `--no-pull`
   * and on a clean pull.
   */
  readonly retrieveFailures?: readonly RetrieveTypeFailure[];
  /**
   * Populated only when `--with-tooling-api` (PLAN-v1.7 R2) runs. The
   * per-run summary surfaces the live-data axis as a separate block in
   * the CLI output; default `sfi refresh` leaves this `undefined` and
   * the printed summary never mentions the Tooling API.
   */
  readonly toolingApi?: ToolingApiRefreshSummary;
  /**
   * Per-directory skip counts surfaced from `walkAndExtract`. Always
   * present (default: empty object) so consumers don't have to
   * special-case the `undefined` form. Keys are top-level DX directory
   * names the walker encountered but the dispatcher couldn't route
   * (e.g. `omniProcesses`, `omniDataTransforms`); values are file
   * counts. The CLI summary emits a structured warning block when this
   * map is non-empty.
   */
  readonly skippedDirectories: Readonly<Record<string, number>>;
  /**
   * Plain-language diff of this refresh against the previous manifest —
   * what the org gained, lost, or (when the source tree is identical) that
   * nothing changed. Populated on success; absent on failure (nothing was
   * written, so there is nothing to compare).
   */
  readonly changeSummary?: ChangeSummary;
  /**
   * Refresh-completion pulse (P9-refresh-pulse) — the interpreted headline of
   * what changed, composed from `changeSummary`. Present on success alongside
   * `changeSummary`; also written best-effort to the gitignored
   * `org-kb/meta/pulse.json`.
   */
  readonly pulse?: RefreshPulse;
  /**
   * P13-REPORTS-default + P14-USAGE-reports-retrieve-fidelity: present when
   * the usage-ranked report/dashboard pull ran — per type: the org total,
   * the manifest members `requested`, and the files that actually LANDED on
   * disk (`retrieved`). `requested > retrieved` means the Metadata API
   * silently dropped members; the CLI summary surfaces the delta.
   */
  readonly reportsCap?: {
    readonly reports: { readonly total: number; readonly requested: number; readonly retrieved: number };
    readonly dashboards: { readonly total: number; readonly requested: number; readonly retrieved: number };
  };
}

/**
 * A refresh-completion pulse (P9-refresh-pulse): the graph growth/shrink plus
 * plain-language watch-lines that route the most review-worthy changes to the
 * deep tools (new automation → `sfi.explain_flow`; new fields → possible PII,
 * `sfi.pii_inventory`; Apex/Flow growth → governor headroom,
 * `sfi.governor_limit_risks`). Composed from the already-computed
 * `ChangeSummary`; count-level, since node-level "which Flow" needs the prior
 * graph, which this refresh has already overwritten.
 */
export interface RefreshPulse {
  readonly graphMetrics: GraphMetricsDelta;
  readonly componentDeltas: Readonly<Record<string, number>>;
  readonly edgeDeltas: Readonly<Record<string, number>>;
  /** The graph headline followed by per-domain watch-lines. */
  readonly highlights: readonly string[];
  /**
   * P13-ANNOT-store: annotated component ids that no longer exist in the
   * fresh graph (deleted/renamed in the org since the annotation was made).
   * The annotation is curated knowledge whose subject vanished — surfaced
   * here so a human re-points or unsets it. ABSENT when there are none, so
   * annotation-free vaults produce byte-identical pulses.
   */
  readonly annotationOrphans?: readonly string[];
}

/**
 * "What changed since last refresh", computed by diffing the new manifest
 * against the previous one. Drives the refresh output's change section so an
 * admin who re-runs `sfi refresh` immediately sees what moved — directly
 * answering "auto-get the latest and tell me what's new".
 */
/**
 * One top-line graph metric across a refresh (P9-regression-on-refresh):
 * `previous` is the count before this refresh (0 on the first), `current` is
 * the count now, and `delta` is the signed change (`current − previous`).
 */
export interface GraphMetricCounts {
  readonly previous: number;
  readonly current: number;
  readonly delta: number;
}

/**
 * Top-line graph metrics N vs N-1 (P9-regression-on-refresh): total component
 * and edge counts with their deltas. Where `componentDeltas` / `edgeDeltas`
 * break the change down per type, this is the headline "the graph grew/shrank
 * by N" regression signal the refresh pulse consumes.
 */
export interface GraphMetricsDelta {
  readonly components: GraphMetricCounts;
  readonly edges: GraphMetricCounts;
}

export interface ChangeSummary {
  /** ISO timestamp of the prior refresh, or null on the very first refresh. */
  readonly previousRefreshedAt: string | null;
  /** True when the source-tree hash differs (the org metadata actually changed). */
  readonly sourceTreeHashChanged: boolean;
  /** Signed per-type component count deltas (after − before); nonzero entries only. */
  readonly componentDeltas: Readonly<Record<string, number>>;
  /** Signed per-edge-type count deltas (after − before); nonzero entries only. */
  readonly edgeDeltas: Readonly<Record<string, number>>;
  /** Top-line total component / edge counts N vs N-1 with deltas (P9-regression-on-refresh). */
  readonly graphMetrics: GraphMetricsDelta;
}

/**
 * Per-run summary of the v1.7 R2 Tooling API enrichment pass. Surfaced
 * in `formatRefreshSummary` as a separate block so the live-data axis
 * is visible to operators even when no nodes were touched (e.g., the
 * enricher's dispatch table missed every type the vault has).
 */
export interface ToolingApiRefreshSummary {
  readonly enrichedCount: number;
  readonly errorCount: number;
  /** Verb summary, e.g. "ok" / "auth-expired" / "rate-limit". */
  readonly outcome: string;
  /**
   * Populated only when the auth or HTTP path failed before any
   * enrichment ran (e.g., `sf` CLI missing). Distinct from per-node
   * `errors`, which are surfaced inside the runner's result.
   */
  readonly fatalMessage?: string;
}

/** Options accepted by `runRefresh`. */
export interface RunRefreshOptions {
  readonly cwd: string;
  /** When true, skip `sf project retrieve`. Tests always set this. */
  readonly noPull: boolean;
  /**
   * Opt-in: also pull folder-based Report / Dashboard metadata (off by default —
   * folder-based + high-volume, so a normal refresh stays fast). Their field usage
   * is folded onto the referenced fields so a report-only field stops reading as
   * unused. Slow on large orgs (enumerates folders + pulls every report/dashboard).
   */
  readonly withReports?: boolean;
  /** Override config.json's `targetOrg` for the retrieve step. */
  readonly targetOrg?: string;
  /** Comma-separated type filter ("CustomObject,Flow"). */
  readonly types?: string;
  /**
   * Opt-in to the v1.7 Tooling API enrichment pass. Off by default —
   * the default refresh stays fully offline. When set, the pipeline
   * runs the offline path to completion, then drives the
   * `tooling-api` enrichment against the in-memory graph and re-imports
   * the patched node rows.
   */
  readonly withToolingApi?: boolean;
  /**
   * P13-FACTS-capture: opt-in budgeted record-data capture into the facts
   * table after the refresh (also requires live consent — skips honestly
   * without it). Best-effort: capture failure never flips refresh status.
   */
  readonly withDataShape?: boolean;
  /**
   * Inject a pre-built Tooling API client. Tests pass a stub; production
   * code leaves this `undefined`, which triggers the
   * `getAuthFromSfCli` + `createToolingApiClient` flow.
   */
  readonly toolingApiClient?: ToolingApiClient;
  /**
   * Optional progress sink, called once per pipeline phase (retrieve, extract,
   * import, render). A full refresh can take minutes with no other output; the
   * CLI wires this to stderr so the run isn't a silent wait. Off by default, so
   * tests and `--json` callers stay quiet.
   */
  readonly onProgress?: (message: string) => void;
  /**
   * Opt-in to the P5-incremental-refresh per-file extraction cache. When set,
   * the pipeline loads `meta/extract-cache.json` and reuses the cached
   * extraction for any source file whose `mtimeMs` + `size` are unchanged,
   * then re-writes the cache. The graph is still FULLY rebuilt from the
   * (reused + freshly-extracted) results, so a stale cache can never leave the
   * graph inconsistent — it only skips the expensive per-file parse. Off by
   * default so the deterministic full-extract path stays the norm.
   */
  readonly incremental?: boolean;
  /**
   * Opt-in to the P7-incremental-graph-update transactional graph apply. When
   * set AND a prior non-empty graph exists, the import re-imports only the
   * changed nodes/edges (a `ChangeSet` diff against the current graph, applied
   * in one all-or-nothing transaction) instead of rebuilding the graph in full.
   * Provably byte-identical to a cold rebuild (the diff reconciles to the exact
   * desired row-set; see `@sf-intelligence/graph` `computeChangeSet`). Falls
   * back to a full rebuild on an empty graph, an over-cap delta, or any apply
   * failure, so the full path stays the source of truth. Independent of
   * `incremental` (the parse cache); the two compose. Off by default.
   */
  readonly incrementalGraph?: boolean;
  /**
   * P13-AST-flip: parser-grade Apex edges run BY DEFAULT (user decision
   * 2026-06-10). Each .cls/.trigger is re-parsed with the vendored ANTLR
   * grammar; resolved field reads/writes and cross-class calls land as
   * `confidence: 'parsed'`, `source: 'apex-ast'` edges. A heuristic
   * scanner edge with an IDENTICAL (from, to, type) parsed twin for the
   * same file is dropped at import (no double-counting); scanner-only
   * edges are KEPT for recall. A file that fails to parse falls back to
   * scanner-only (counted in the manifest's `apexAst` block). Pass
   * `apexAst: false` (CLI `--no-apex-ast`) to opt out.
   */
  readonly apexAst?: boolean;
  /**
   * P13-STAGED-tiers: skip the Markdown render (and the post-render hooks
   * that presume a complete graph — history, pulse, risk scores, onboarding
   * doc, org card, snapshot). Manifest counts come from graph GROUP-BY
   * queries instead of the render drain. Used by mid-build staged tiers so
   * the expensive render runs once, at the final tier. The refresh-epoch
   * bump still fires so an open MCP server hot-reloads the tier's data.
   */
  readonly skipRender?: boolean;
  /**
   * P13-STAGED-tiers: force the side-build path even when the graph file is
   * not locked — build into `graph.duckdb.rebuild` and atomically rename
   * over the target only on success. A failure (or a kill) mid-run leaves
   * the previous graph byte-untouched, which is the staged final tier's
   * transactional guarantee: mid-T2 death keeps the T1 vault servable.
   */
  readonly forceSideBuild?: boolean;
  /**
   * P13-STAGED-tiers: stamp this mid-build marker into the manifest and mark
   * its `pendingTypes` as `pending` coverage rows. Set by the staged driver
   * for non-final tiers only — the final tier omits it, which is what clears
   * the marker (and the degraded health status) on completion.
   */
  readonly stagedMarker?: StagedBuildMarker;
}

export interface VaultConfig {
  readonly targetOrg: string;
  readonly vaultRoot: string;
  /** When not `false`, a graph snapshot is captured after each successful refresh. */
  readonly snapshotOnRefresh: boolean;
}

const EMPTY_COUNTS = { components: {}, edges: {} } as const;
const EMPTY_SKIPPED: Readonly<Record<string, number>> = Object.freeze({});

/** Build a `failed` RefreshResult — shared across the pipeline's error branches. */
const failed = (
  startedMs: number,
  fatalError: string,
  errors: readonly RefreshExtractionFailure[],
  counts: RefreshResult['counts'] = EMPTY_COUNTS,
  skippedDirectories: Readonly<Record<string, number>> = EMPTY_SKIPPED,
): RefreshResult => ({
  status: 'failed',
  counts,
  errors,
  durationMs: Date.now() - startedMs,
  fatalError,
  skippedDirectories,
});

/**
 * On-disk shape of `meta/extract-cache.json` (P5-incremental-refresh). The
 * cache is invalidated wholesale when EITHER `cacheVersion` (extractor graph
 * shape) OR `packageVersion` (any product upgrade) differs from the running
 * build, so a reused entry always came from the SAME extractor — never a parse
 * from older code masquerading as current.
 */
interface ExtractCacheFile {
  readonly cacheVersion: number;
  readonly packageVersion: string;
  readonly entries: readonly {
    readonly key: string;
    readonly mtimeMs: number;
    readonly size: number;
    readonly result: ExtractionResult;
  }[];
}

/** Version of the running build, stamped into the cache + the manifest. */
const PACKAGE_VERSION = readCliPackageVersion();

/** Absolute path to the incremental-refresh extraction cache sidecar. */
const extractCachePath = (metaDir: string): string =>
  join(metaDir, 'extract-cache.json');

/**
 * Load the per-file extraction cache (P5-incremental-refresh). Returns an empty
 * Map — i.e. "extract everything" — on ANY of: file absent (first incremental
 * run), unreadable, malformed, or a `cacheVersion`/`packageVersion` mismatch.
 * The cache is a pure optimization, so a load failure must never fail or alter
 * a refresh; it only forgoes the speedup.
 */
const loadExtractCache = async (metaDir: string): Promise<ExtractCache> => {
  try {
    const raw = await readFile(extractCachePath(metaDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExtractCacheFile>;
    if (
      parsed.cacheVersion !== EXTRACT_CACHE_VERSION ||
      parsed.packageVersion !== PACKAGE_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      return new Map();
    }
    const cache: ExtractCache = new Map();
    for (const e of parsed.entries) {
      if (
        typeof e?.key === 'string' &&
        typeof e?.mtimeMs === 'number' &&
        typeof e?.size === 'number' &&
        e?.result !== undefined
      ) {
        cache.set(e.key, { mtimeMs: e.mtimeMs, size: e.size, result: e.result });
      }
    }
    return cache;
  } catch {
    return new Map();
  }
};

/**
 * Persist the per-file extraction cache for the next incremental refresh
 * (P5-incremental-refresh). Best-effort: a write failure is swallowed (the
 * refresh already succeeded; the only cost is a cold next run).
 */
const saveExtractCache = async (
  metaDir: string,
  cache: ExtractCache,
): Promise<void> => {
  try {
    const file: ExtractCacheFile = {
      cacheVersion: EXTRACT_CACHE_VERSION,
      packageVersion: PACKAGE_VERSION,
      entries: [...cache.entries()].map(([key, v]) => ({
        key,
        mtimeMs: v.mtimeMs,
        size: v.size,
        result: v.result,
      })),
    };
    await mkdir(metaDir, { recursive: true });
    await writeFile(extractCachePath(metaDir), JSON.stringify(file), 'utf8');
  } catch {
    // non-fatal — the next refresh just re-extracts from cold.
  }
};

/**
 * The end-to-end refresh pipeline as a pure async function. Splitting it
 * from the commander handler lets tests pre-seed `org-kb/source/` and
 * drive the flow without spawning `sf`.
 *
 * @example
 *   const result = await runRefresh({ cwd: process.cwd(), noPull: true });
 */
/**
 * P13-AST-edges: run the parser-grade extractor over every walked Apex file
 * and append `source: 'apex-ast'`, `confidence: 'parsed'` edges. Field
 * reads/writes map to `CustomField:Object.Field` (first two chain segments);
 * cross-class calls map to `callsApex` on known vault classes (system
 * allowlist calls carry no graph node and are skipped). A parse failure
 * leaves that file scanner-only.
 */
const applyApexAstEdges = async (
  results: readonly ExtractionResult[],
  progress: (message: string) => void,
): Promise<{
  readonly results: readonly ExtractionResult[];
  readonly filesParsed: number;
  readonly parseErrors: number;
  readonly edgesAdded: number;
}> => {
  const { extractApexAstEdges } = await import(
    '@sf-intelligence/parsers/apex-ast'
  );
  const knownClasses = new Set<string>();
  for (const r of results) {
    for (const n of r.nodes) {
      if (n.type === 'ApexClass' || n.type === 'ApexTrigger') knownClasses.add(n.apiName);
    }
  }
  let filesParsed = 0;
  let parseErrors = 0;
  let edgesAdded = 0;
  const out: ExtractionResult[] = [];
  for (const r of results) {
    const apexNode = r.nodes.find(
      (n) => (n.type === 'ApexClass' || n.type === 'ApexTrigger') && /\.(cls|trigger)$/.test(n.sourcePath),
    );
    if (apexNode === undefined) {
      out.push(r);
      continue;
    }
    let source: string;
    try {
      source = await readFile(apexNode.sourcePath, 'utf8');
    } catch {
      out.push(r);
      continue;
    }
    const extracted = extractApexAstEdges(source, apexNode.apiName, {
      knownClasses,
      // kind from the EXTENSION — content sniffing breaks on comment-first triggers
      kind: apexNode.sourcePath.endsWith('.trigger') ? 'trigger' : 'class',
    });
    if (extracted.parseError !== undefined) {
      parseErrors += 1;
      progress(`  apex-ast fallback (scanner-only): ${apexNode.apiName} — ${extracted.parseError}`);
      out.push(r);
      continue;
    }
    filesParsed += 1;
    const newEdges = [...r.edges];
    const pushEdge = (toId: string, edgeType: string, props: Record<string, unknown>): void => {
      if (toId === apexNode.id) return;
      newEdges.push({
        fromId: apexNode.id,
        toId: toId as ComponentId,
        edgeType: edgeType as never,
        confidence: 'parsed',
        source: 'apex-ast',
        properties: props,
      } as never);
      edgesAdded += 1;
    };
    // Aggregate calls per target class: ONE callsApex edge carrying the
    // full `methods` array (the scanner's convention — consumers like
    // call_graph read it; per-method edges would collide on the edge PK
    // and surface an empty method list).
    const callsByClass = new Map<string, string[]>();
    for (const call of extracted.calls) {
      const cls = call.split('.')[0] ?? '';
      const method = call.split('.').slice(1).join('.');
      if (knownClasses.has(cls) && cls !== apexNode.apiName) {
        const list = callsByClass.get(cls) ?? [];
        list.push(method);
        callsByClass.set(cls, list);
      }
    }
    // CR-CAP-06: thread per-target-class CALLER-method attribution onto the
    // SAME single edge per target class — property-only, edge PK/count are
    // byte-identical (one callsApex edge per target class as before). Two
    // ADDITIVE keys, AST-PATH-ONLY:
    //   - callerMethods: the class-level UNION of source methods that call
    //     ANY method of the target (for call_graph — class->class label).
    //   - callerMethodsByMethod: target-method -> source-methods that call
    //     THAT specific method (for what_if — so it can attribute the call-site
    //     to the queried method without the cross-method phantom the flat union
    //     would introduce).
    // A call-site with no enclosing method (callerMethod === '') is FILTERED
    // here — absent === unknown caller, never a blank attribution.
    const callerMethodsByClass = new Map<string, Set<string>>();
    const callerMethodsByMethod = new Map<string, Map<string, Set<string>>>();
    for (const site of extracted.callSites ?? []) {
      const cls = site.callee.split('.')[0] ?? '';
      const targetMethod = site.callee.split('.').slice(1).join('.');
      if (!(knownClasses.has(cls) && cls !== apexNode.apiName)) continue;
      if (site.callerMethod.length === 0) continue;
      const union = callerMethodsByClass.get(cls) ?? new Set<string>();
      union.add(site.callerMethod);
      callerMethodsByClass.set(cls, union);
      if (targetMethod.length > 0) {
        const byMethod = callerMethodsByMethod.get(cls) ?? new Map<string, Set<string>>();
        const callers = byMethod.get(targetMethod) ?? new Set<string>();
        callers.add(site.callerMethod);
        byMethod.set(targetMethod, callers);
        callerMethodsByMethod.set(cls, byMethod);
      }
    }
    for (const [cls, methods] of callsByClass) {
      const callerUnion = callerMethodsByClass.get(cls);
      const byMethod = callerMethodsByMethod.get(cls);
      const byMethodObj =
        byMethod === undefined
          ? undefined
          : Object.fromEntries(
              [...byMethod.entries()]
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                .map(([m, callers]) => [m, [...callers].sort()] as const),
            );
      pushEdge(`ApexClass:${cls}`, 'callsApex', {
        methods: [...new Set(methods)].sort(),
        viaAst: true,
        ...(callerUnion !== undefined && callerUnion.size > 0
          ? { callerMethods: [...callerUnion].sort() }
          : {}),
        ...(byMethodObj !== undefined && Object.keys(byMethodObj).length > 0
          ? { callerMethodsByMethod: byMethodObj }
          : {}),
      });
    }
    const fieldEdge = (ref: string, kind: 'readsFrom' | 'writesTo'): void => {
      const segs = ref.split('.');
      if (segs.length < 2) return;
      pushEdge(`CustomField:${segs[0]}.${segs[1]}`, kind, { path: ref, viaAst: true });
    };
    for (const read of extracted.reads) fieldEdge(read, 'readsFrom');
    for (const write of extracted.writes) fieldEdge(write, 'writesTo');
    // P13-AST-flip: a heuristic scanner edge with an IDENTICAL
    // (from, to, type) parsed twin is redundant — drop it so consumers
    // never double-count one real reference. Scanner-only edges stay
    // (recall the parser may lack); parsed edges win on duplicates.
    const parsedKeys = new Set(
      newEdges
        .filter((edge) => (edge as { source?: string }).source === 'apex-ast')
        .map((edge) => `${edge.fromId}|${edge.toId}|${edge.edgeType}`),
    );
    // P14-USAGE-scanner-fp-downgrade: on a successfully PARSED file the AST
    // also proves which receivers are CLASS TYPES (inner classes + the class
    // itself) — the scanner's `CustomField:{Type}.{prop}` edges keyed on them
    // are typed false positives (`CustomField:ReportWrapper.id` for an inner
    // wrapper write), and a field literally named `class` is the
    // `Type.class` literal (reserved word — never a real field). Drop both
    // classes; everything else stays for recall.
    const typedReceivers = new Set(
      [...(extracted.innerTypes ?? []), apexNode.apiName].map((t) => t.toLowerCase()),
    );
    const isTypedReceiverFp = (edge: { toId: string; edgeType: string; confidence: string }): boolean => {
      if (edge.confidence !== 'heuristic') return false;
      if (edge.edgeType !== 'readsFrom' && edge.edgeType !== 'writesTo') return false;
      const m = /^CustomField:([^.]+)\.(.+)$/.exec(edge.toId);
      if (m === null) return false;
      const receiver = (m[1] ?? '').toLowerCase();
      const field = m[2] ?? '';
      return typedReceivers.has(receiver) || field === 'class';
    };
    const deduped = newEdges.filter(
      (edge) =>
        (edge as { source?: string }).source === 'apex-ast' ||
        (edge.confidence !== 'heuristic' ||
          !parsedKeys.has(`${edge.fromId}|${edge.toId}|${edge.edgeType}`)) &&
          !isTypedReceiverFp(edge as { toId: string; edgeType: string; confidence: string }),
    );
    out.push({ ...r, edges: deduped });
  }
  return { results: out, filesParsed, parseErrors, edgesAdded };
};

export const runRefresh = async (opts: RunRefreshOptions): Promise<RefreshResult> => {
  const started = Date.now();

  const configResult = await loadVaultConfig(opts.cwd);
  if (!configResult.ok) return failed(started, configResult.error, []);
  const paths = vaultPaths(configResult.value.vaultRoot);
  const targetOrg = opts.targetOrg ?? configResult.value.targetOrg;
  // Defense in depth (CR-01 / C1): the `--target-org` flag bypasses config.json
  // (which loadVaultConfig already gates), so validate the flag override too.
  if (opts.targetOrg !== undefined) {
    const aliasCheck = validateOrgAlias(opts.targetOrg);
    if (!aliasCheck.ok) return failed(started, aliasCheck.error, []);
  }

  const requestedTypes = parseTypeFilter(opts.types);
  const progress = opts.onProgress ?? (() => {});
  let pullManifestTypes: readonly ComponentType[] | null = null;
  // CR-P3-3: describe-confirmed-and-cleanly-retrieved types from the main
  // pull. Stays null on `--no-pull` (no retrieve ran) and on a describe-blind
  // pull, so confirmed-empty reclassification only fires after a full live
  // refresh whose describe succeeded.
  let confirmedTypes: ReadonlySet<ComponentType> | null = null;
  let sourceReconcileDeleted = 0;
  let retrieveFailures: readonly RetrieveTypeFailure[] = [];

  if (!opts.noPull) {
    // Preflight: set expectations before a long retrieve (P12-FIRSTRUN-refresh-preflight).
    const priorManifest = await loadManifest(configResult.value.vaultRoot);
    const priorComponentCount = priorManifest.ok
      ? Object.values(priorManifest.value.components ?? {}).reduce(
          (a, b) => a + (typeof b === 'number' ? b : 0),
          0,
        )
      : null;
    const sizeNote = assessRefreshSize({
      priorComponentCount,
      scoped: requestedTypes !== null,
      noPull: false,
    });
    if (sizeNote.message) progress(sizeNote.message);

    progress(`Retrieving metadata from ${targetOrg} (this can take several minutes)...`);
    const pulled = await runSfRetrieve(targetOrg, paths.source, requestedTypes);
    if (!pulled.ok) return failed(started, pulled.error, []);
    pullManifestTypes = pulled.value.manifestTypes;
    confirmedTypes = pulled.value.confirmedTypes;
    sourceReconcileDeleted = pulled.value.deletedCount;
    retrieveFailures = pulled.value.failures;
    if (sourceReconcileDeleted > 0) {
      progress(
        `Reconciled source: removed ${sourceReconcileDeleted} stale file(s) deleted in the org.`,
      );
    }
    if (retrieveFailures.length > 0) {
      // The refresh did NOT abort: every other type landed and the vault is
      // built from what it could retrieve. Name the skipped types and the real
      // per-type cause so a partial pull is visible, not silent.
      progress(
        `Partial retrieve: ${retrieveFailures.length} metadata type(s) failed and were skipped — ` +
          `the vault is built from what landed. ${summarizeRetrieveFailures(retrieveFailures)}`,
      );
    }
  }

  progress('Extracting components from retrieved source...');
  // P5-incremental-refresh: when opted in, prime the walk with the prior
  // run's per-file cache so unchanged files skip re-extraction. The same
  // `prevCache` seeds BOTH the first walk and the post-expansion re-walk —
  // the auto-expansion only ADDS files (never in the old cache), so they
  // always extract fresh while everything else stays reused.
  const prevCache = opts.incremental
    ? await loadExtractCache(paths.meta)
    : undefined;
  let walked = await walkAndExtract(paths.source, requestedTypes, prevCache);
  if (opts.incremental) {
    progress(
      `Incremental: reused ${walked.reusedCount} unchanged file(s) from cache.`,
    );
  }

  // B29 auto-expansion: a trigger / flow / Apex reference can target a
  // CustomObject the `<members>*</members>` wildcard excluded (a managed object,
  // or a single-underscore-prefixed custom object — e.g. an admissions-template
  // package). Pull those referenced-but-missing objects in a second pass and
  // re-extract so the analysis is not left with a phantom. Best-effort, gated to
  // a live refresh that includes CustomObject; never aborts the refresh.
  if (
    !opts.noPull &&
    (requestedTypes === null || requestedTypes.has('CustomObject'))
  ) {
    const expand = objectsToExpandManifest(walked.results);
    if (expand.length > 0) {
      progress(
        `Auto-expanding retrieve: ${expand.length} object(s) your automation references but the wildcard excluded...`,
      );
      const pulled2 = await runSfRetrieveObjects(targetOrg, paths.source, expand);
      if (pulled2.ok) {
        walked = await walkAndExtract(paths.source, requestedTypes, prevCache);
      } else {
        progress(`Auto-expansion retrieve skipped (non-fatal): ${pulled2.error}`);
      }
    }
  }

  // Folder-based Report / Dashboard metadata is invisible to the
  // `<members>*</members>` retrieve. Three modes (P13-REPORTS-default,
  // user decision 2026-06-10):
  //   --with-reports  → FULL folder pull (uncapped; slow on big orgs)
  //   default         → SMART pull: top SFI_REPORTS_CAP (500) by USAGE
  //                     (Report.LastRunDate / Dashboard.LastViewedDate,
  //                     fallback LastModifiedDate); coverage goes `pending`
  //                     for the beyond-cap remainder
  //   --no-reports    → skip entirely
  // Best-effort + never aborts the refresh; full refreshes only (a scoped
  // --types run should not surprise-pull reports).
  let reportsCapStats:
    | {
        readonly reports: { readonly total: number; readonly requested: number; readonly retrieved: number };
        readonly dashboards: { readonly total: number; readonly requested: number; readonly retrieved: number };
      }
    | undefined;
  if (opts.withReports === true && !opts.noPull) {
    progress('Pulling ALL folder-based Reports / Dashboards (--with-reports)...');
    const pulledReports = await runSfRetrieveFolderedReports(targetOrg, paths.source);
    if (!pulledReports.ok) {
      progress(`--with-reports pull skipped (non-fatal): ${pulledReports.error}`);
    } else if (pulledReports.value.reports + pulledReports.value.dashboards > 0) {
      progress(
        `Requested ${pulledReports.value.reports} report(s) + ${pulledReports.value.dashboards} dashboard(s); re-extracting...`,
      );
      walked = await walkAndExtract(paths.source, requestedTypes, prevCache);
    }
  } else if (opts.withReports === undefined && !opts.noPull && requestedTypes === null) {
    const cap = reportsCap();
    if (cap > 0) {
      progress(`Pulling top ${cap} Reports / Dashboards by usage (default; --no-reports to skip)...`);
      const smart = await runSfRetrieveSmartReports(targetOrg, paths.source, cap);
      if (!smart.ok) {
        progress(`smart report pull skipped (non-fatal): ${smart.error}`);
      } else {
        // P14-USAGE-reports-retrieve-fidelity: `retrieved` records what
        // actually LANDED on disk, not what the manifest requested — the
        // Metadata API can silently drop members (a live run delivered 78 of
        // 83 requested dashboards). requested > retrieved means drops, and
        // the coverage decorator keeps those rows `pending`.
        reportsCapStats = {
          reports: { total: smart.value.totals.reports, requested: smart.value.reports, retrieved: smart.value.landed.reports },
          dashboards: { total: smart.value.totals.dashboards, requested: smart.value.dashboards, retrieved: smart.value.landed.dashboards },
        };
        if (smart.value.reports + smart.value.dashboards > 0) {
          progress(
            `Landed ${smart.value.landed.reports}/${smart.value.reports} requested report(s) + ${smart.value.landed.dashboards}/${smart.value.dashboards} requested dashboard(s) (org totals ${smart.value.totals.reports} / ${smart.value.totals.dashboards}); re-extracting...`,
          );
          if (smart.value.missing.length > 0) {
            progress(
              `${smart.value.missing.length} requested member(s) did not land on disk (deleted since the ranking query, folder mismatch, or dropped by the retrieve without an error): ${smart.value.missing.slice(0, 5).join(', ')}${smart.value.missing.length > 5 ? ', …' : ''}`,
            );
          }
          walked = await walkAndExtract(paths.source, requestedTypes, prevCache);
        }
      }
    }
  }

  // Fold report/dashboard field usage onto the referenced fields and drop the
  // (folder-based, high-volume) report/dashboard nodes — the usage lives on the
  // field, with no per-report node bloat. No-op when none were retrieved.
  walked = { ...walked, results: foldReportDashboardUsageIntoFields(walked.results) };

  // FLD-05: org describe snapshot for standard-object fields (Account, Contact, …).
  // Read-only `sf sobject describe` — safe on --no-pull (no metadata retrieve).
  walked = await appendStandardObjectDescribeFields(targetOrg, walked, progress);

  // P13-AST-edges: opt-in parser-grade Apex edge pass (lazy import — the
  // default path never loads the ANTLR grammar). Best-effort per file:
  // parse failures fall back to scanner-only and are counted.
  let apexAstStats: { readonly filesParsed: number; readonly parseErrors: number } | undefined;
  if (opts.apexAst !== false) {
    progress('Apex AST pass (default; --no-apex-ast to skip): parser-grade edges...');
    const astResult = await applyApexAstEdges(walked.results, progress);
    walked = { ...walked, results: astResult.results };
    apexAstStats = { filesParsed: astResult.filesParsed, parseErrors: astResult.parseErrors };
    progress(
      `Apex AST: ${astResult.filesParsed} file(s) parsed, ${astResult.edgesAdded} parsed edge(s) added, ${astResult.parseErrors} fallback(s) to scanner.`,
    );
  }
  progress(`Extracted ${walked.results.length} component file(s); building graph...`);

  // P5-incremental-refresh: persist the freshly-walked cache for next time.
  // Safe to write here (before the graph build): the graph is ALWAYS rebuilt
  // in full from `walked.results`, so the cache only ever short-circuits the
  // per-file parse, never the import/render.
  if (opts.incremental) await saveExtractCache(paths.meta, walked.cache);

  await mkdir(paths.graph, { recursive: true });
  // P13-WATCH-epoch: when an open MCP server holds the graph file (DuckDB
  // refuses a writer while ANY process holds a handle, read-only included),
  // build into a SIDE file and atomically rename it over the target at the
  // end — POSIX rename succeeds despite open handles; the server's old
  // handle keeps the unlinked previous file, and the refresh-epoch bump
  // makes it reopen the NEW file on its next call. No pkill, no restart.
  let graphTarget = paths.graphDb;
  let renameOver = false;
  let storeResult: Awaited<ReturnType<typeof openGraph>>;
  if (opts.forceSideBuild === true) {
    // P13-STAGED-tiers: transactional full build — never touch the live
    // graph file until the whole tier succeeded.
    graphTarget = `${paths.graphDb}.rebuild`;
    await rm(graphTarget, { force: true });
    await rm(`${graphTarget}.wal`, { force: true });
    renameOver = true;
    storeResult = await openGraph(graphTarget);
  } else {
    storeResult = await openGraph(graphTarget);
    if (!storeResult.ok && /locked|Conflicting lock/i.test(storeResult.error.message)) {
      graphTarget = `${paths.graphDb}.rebuild`;
      await rm(graphTarget, { force: true });
      await rm(`${graphTarget}.wal`, { force: true });
      renameOver = true;
      storeResult = await openGraph(graphTarget);
    }
  }
  if (!storeResult.ok) {
    return failed(started, `openGraph: ${storeResult.error.message}`, walked.failures);
  }
  const reconciledTypes = computeReconciledTypes(
    pullManifestTypes,
    paths.source,
    walked.failures,
  );
  const commonArgs = {
    paths,
    started,
    targetOrg,
    walked,
    opts,
    requestedTypes,
    confirmedTypes,
    snapshotOnRefresh: configResult.value.snapshotOnRefresh,
    retrieveFailures,
    ...(reconciledTypes !== null ? { reconciledTypes } : {}),
    ...(apexAstStats !== undefined ? { apexAstStats } : {}),
    ...(reportsCapStats !== undefined ? { reportsCapStats } : {}),
  };

  if (!renameOver) {
    try {
      return await runWithOpenGraph({ store: storeResult.value, ...commonArgs });
    } finally {
      await closeGraph(storeResult.value);
    }
  }

  // A side-build has two explicit phases. Phase 1 mutates only the replacement
  // graph. After it closes successfully, the graph is installed atomically.
  // Phase 2 reopens that installed graph and publishes every graph-dependent
  // live-vault artifact. A failed/killed phase 1 therefore cannot leave a new
  // manifest or rendered document pointing at the old graph.
  let buildResult: RefreshResult;
  try {
    try {
      const preserved = await preserveFactsForSideBuild(paths.graphDb, storeResult.value);
      buildResult = preserved.ok
        ? await runWithOpenGraph({
            store: storeResult.value,
            ...commonArgs,
            buildOnly: true,
          })
        : failed(started, `preserve facts: ${preserved.error}`, walked.failures);
    } finally {
      await closeGraph(storeResult.value);
    }
  } catch (cause) {
    await rm(graphTarget, { force: true });
    await rm(`${graphTarget}.wal`, { force: true });
    throw cause;
  }

  if (buildResult.status === 'failed') {
    await rm(graphTarget, { force: true });
    await rm(`${graphTarget}.wal`, { force: true });
    return buildResult;
  }

  // Atomic swap: open server handles keep the old (now-unlinked) file until
  // their next call notices the epoch bump and reopens this one.
  await rename(graphTarget, paths.graphDb);
  const installed = await openGraph(paths.graphDb);
  if (!installed.ok) {
    return failed(started, `open installed side-build: ${installed.error.message}`, walked.failures);
  }
  try {
    return await runWithOpenGraph({
      store: installed.value,
      ...commonArgs,
      publishOnly: true,
      ...(buildResult.toolingApi !== undefined
        ? { toolingApiSummary: buildResult.toolingApi }
        : {}),
    });
  } finally {
    await closeGraph(installed.value);
  }
};

const preserveFactsForSideBuild = async (
  liveGraphPath: string,
  replacement: GraphStore,
): Promise<Result<number, string>> => {
  try {
    await stat(liveGraphPath);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ? ok(0)
      : err(`cannot inspect live graph before side-build: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const live = await openGraphReadOnly(liveGraphPath);
  if (!live.ok) return err(live.error.message);
  try {
    const copied = await copyFacts(live.value, replacement);
    return copied.ok ? ok(copied.value) : err(copied.error.message);
  } finally {
    await closeGraph(live.value);
  }
};

interface RunWithOpenGraphArgs {
  /** Types whose source was reconciled against the org retrieve this run. */
  readonly reconciledTypes?: ReadonlySet<ComponentType>;
  readonly apexAstStats?: { readonly filesParsed: number; readonly parseErrors: number };
  readonly reportsCapStats?: {
    readonly reports: { readonly total: number; readonly requested: number; readonly retrieved: number };
    readonly dashboards: { readonly total: number; readonly requested: number; readonly retrieved: number };
  };
  readonly store: GraphStore;
  readonly paths: ReturnType<typeof vaultPaths>;
  readonly started: number;
  readonly targetOrg: string;
  readonly walked: Awaited<ReturnType<typeof walkAndExtract>>;
  readonly opts: RunRefreshOptions;
  readonly requestedTypes: ReadonlySet<ComponentType> | null;
  /**
   * CR-P3-3: describe-confirmed, cleanly-retrieved types from the main pull;
   * null on `--no-pull` (no retrieve ran) and on a describe-blind pull. Drives
   * `CoverageEntry.retrieveConfirmed` in `buildCoverageEntries`.
   */
  readonly confirmedTypes: ReadonlySet<ComponentType> | null;
  readonly snapshotOnRefresh: boolean;
  /** Metadata types that failed the retrieve this run (empty on a clean pull). */
  readonly retrieveFailures: readonly RetrieveTypeFailure[];
  /** Side-build phase 1: mutate only the replacement graph, publish nothing. */
  readonly buildOnly?: boolean;
  /** Side-build phase 2: publish from the installed graph without re-importing. */
  readonly publishOnly?: boolean;
  /** Preserve the phase-1 enrichment summary in the final published result. */
  readonly toolingApiSummary?: ToolingApiRefreshSummary;
}

/**
 * Build the additive v4.0 manifest coverage rows from what this refresh
 * actually rendered plus what the walker skipped. The generated package.xml
 * requests every supported type unless the operator supplied `--types`, so the
 * coverage row's `requested` flag reflects that narrowed run.
 */
const aggregateFailuresByType = (
  sourceRoot: string,
  failures: readonly RefreshExtractionFailure[],
): ReadonlyMap<ComponentType, { readonly count: number; readonly sampleReason: string }> => {
  const byType = new Map<ComponentType, { count: number; sampleReason: string }>();
  for (const failure of failures) {
    const type = componentTypeFromSourcePath(sourceRoot, failure.path, false);
    if (type === null) continue;
    const existing = byType.get(type);
    if (existing === undefined) {
      byType.set(type, {
        count: 1,
        sampleReason: `${failure.error.kind}: ${failure.error.message}`,
      });
    } else {
      byType.set(type, { count: existing.count + 1, sampleReason: existing.sampleReason });
    }
  }
  return byType;
};

const buildCoverageEntries = (
  counts: RefreshResult['counts'],
  skippedDirectories: Readonly<Record<string, number>>,
  requestedTypes: ReadonlySet<ComponentType> | null,
  sourceRoot: string,
  failures: readonly RefreshExtractionFailure[],
  confirmedTypes: ReadonlySet<ComponentType> | null,
): readonly CoverageEntry[] => {
  const failuresByType = aggregateFailuresByType(sourceRoot, failures);
  const entries: CoverageEntry[] = [];
  for (const type of SUPPORTED_TYPES) {
    const requested = requestedTypes === null || requestedTypes.has(type);
    const failureInfo = failuresByType.get(type);
    const errored = failureInfo !== undefined && failureInfo.count > 0;
    // CR-P3-3: `retrieveConfirmed` is set ONLY when the describe-confirmed,
    // cleanly-retrieved set (`confirmedTypes`, null on `--no-pull` /
    // describe-blind pull) contains this type AND it did not error. This is the
    // sole honest signal that a `retrieved: 0` row is a CONFIRMED-empty org
    // (reclassifiable to complete) rather than a not-retrieved / dropped one.
    // It is NOT derived from `requested` (in-package.xml ≠ retrieve completed)
    // and stays unset for capped/dropped types — `decorateReportsCapCoverage`
    // marks those `pending`, and the classifiers require `pending !== true`
    // before honoring `retrieveConfirmed`, so a capped/dropped pull never reads
    // as confirmed-empty even though it may carry retrieveConfirmed.
    const retrieveConfirmed =
      confirmedTypes !== null && confirmedTypes.has(type) && !errored;
    entries.push({
      type,
      requested,
      retrieved: counts.components[type] ?? 0,
      errored,
      ...(errored ? { errorReason: failureInfo.sampleReason } : {}),
      neverModeled: false,
      ...(retrieveConfirmed ? { retrieveConfirmed: true } : {}),
    });
  }

  for (const [type, count] of Object.entries(skippedDirectories)) {
    entries.push({
      type: type as ComponentType,
      requested: true,
      retrieved: count,
      errored: false,
      neverModeled: true,
    });
  }

  return entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
};

/**
 * P13-STAGED-tiers: mark the staged marker's still-queued types as `pending`
 * coverage rows. A pending row keeps `requested: true, retrieved: 0`, so
 * readers that predate the flag partition it as partial coverage — absence
 * caveats still fire — while new readers can say "queued, build in progress"
 * instead of "missing". No-op without a marker.
 */
const decoratePendingCoverage = (
  entries: readonly CoverageEntry[],
  marker: StagedBuildMarker | undefined,
): readonly CoverageEntry[] => {
  if (marker === undefined || marker.pendingTypes.length === 0) return entries;
  const pending = new Set(marker.pendingTypes);
  return entries.map((entry) =>
    pending.has(entry.type)
      ? { ...entry, requested: true, pending: true }
      : entry,
  );
};

/**
 * P13-REPORTS-default: when the usage-ranked pull was CAPPED (org holds more
 * reports/dashboards than the cap), the Report/Dashboard coverage rows go
 * `pending` — the un-pulled tail was NOT checked, so absence claims about
 * report usage must stay qualified (same machinery as staged pending rows).
 * Fully-pulled orgs (total ≤ cap) read as plainly covered.
 * P14-USAGE-reports-retrieve-fidelity: `retrieved` is what actually LANDED
 * on disk, so the same `total > retrieved` test now also keeps rows pending
 * when the retrieve silently dropped requested members.
 */
const decorateReportsCapCoverage = (
  entries: readonly CoverageEntry[],
  stats:
    | {
        readonly reports: { readonly total: number; readonly requested: number; readonly retrieved: number };
        readonly dashboards: { readonly total: number; readonly requested: number; readonly retrieved: number };
      }
    | undefined,
): readonly CoverageEntry[] => {
  if (stats === undefined) return entries;
  const capped = new Map<string, { total: number; retrieved: number }>();
  if (stats.reports.total > stats.reports.retrieved) capped.set('Report', stats.reports);
  if (stats.dashboards.total > stats.dashboards.retrieved) capped.set('Dashboard', stats.dashboards);
  if (capped.size === 0) return entries;
  const out = entries.map((entry) =>
    capped.has(entry.type) ? { ...entry, requested: true, pending: true } : entry,
  );
  for (const [type, c] of capped) {
    if (!out.some((entry) => entry.type === type)) {
      out.push({ type, requested: true, retrieved: c.retrieved, errored: false, neverModeled: false, pending: true });
    }
  }
  return [...out].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
};

/**
 * P13-STAGED-tiers: manifest counts without the render drain — one GROUP BY
 * per table. `listNodesByType` applies no filter beyond `type = ?`, so for
 * supported types these totals equal what a render-derived count would
 * report; mid-build manifests use them so the expensive Markdown render runs
 * once, at the final tier.
 */
const countGraphTotals = async (
  store: GraphStore,
): Promise<Result<RefreshResult['counts'], string>> => {
  try {
    const components: Partial<Record<ComponentType, number>> = {};
    const nodeReader = await store.connection.runAndReadAll(
      'SELECT type, COUNT(*) AS n FROM nodes GROUP BY type;',
    );
    for (const row of nodeReader.getRowObjectsJS() as readonly Record<string, unknown>[]) {
      const type = String(row['type']);
      if ((SUPPORTED_TYPES as readonly string[]).includes(type)) {
        components[type as ComponentType] = Number(row['n']);
      }
    }
    const edges: Partial<Record<EdgeType, number>> = {};
    const edgeReader = await store.connection.runAndReadAll(
      'SELECT edge_type, COUNT(*) AS n FROM edges GROUP BY edge_type;',
    );
    for (const row of edgeReader.getRowObjectsJS() as readonly Record<string, unknown>[]) {
      edges[String(row['edge_type']) as EdgeType] = Number(row['n']);
    }
    return ok({ components, edges });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
};

/**
 * Truncate both graph tables and re-import in full — the incremental path's
 * fallback. After the DELETEs the tables are empty, so the subsequent full
 * import reproduces exactly the rows a cold rebuild into a fresh database would,
 * keeping the "byte-identical to a cold rebuild" contract even when the
 * incremental apply is skipped. (P7-incremental-graph-update.)
 */
const fullRebuild = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<Result<ImportCounts, GraphError>> => {
  try {
    await store.connection.run('DELETE FROM edges;');
    await store.connection.run('DELETE FROM nodes;');
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `incremental-graph fallback truncate failed: ${(e as Error).message}`,
    });
  }
  return importExtractionResults(store, results);
};

/**
 * Import `results` into the open graph, choosing the strategy:
 *  - default: the full batched `importExtractionResults` (the source of truth);
 *  - `--incremental-graph`: a `ChangeSet` diff against the current graph applied
 *    in one all-or-nothing transaction, re-importing ONLY changed rows.
 *
 * The incremental path falls back to a full rebuild (truncate + full import) on
 * a diff-read failure, an over-`INCREMENTAL_DELTA_CAP` delta (an empty or
 * largely-changed graph — a full batched rebuild is correct AND avoids a large
 * single-transaction working set), or any apply failure — including the
 * apply's own post-write count self-check. So the incremental path's result is
 * always byte-identical to a cold rebuild; it only ever changes HOW the same
 * end state is reached.
 */
const importGraph = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
  opts: RunRefreshOptions,
  requestedTypes: ReadonlySet<ComponentType> | null,
  failures: readonly RefreshExtractionFailure[],
  progress: (message: string) => void,
  reconciledTypes?: ReadonlySet<ComponentType>,
): Promise<Result<ImportCounts | ApplyCounts, GraphError>> => {
  if (opts.incrementalGraph !== true) {
    // Deletion reconciliation (the safe case). The default import is upsert-only
    // (`INSERT OR REPLACE`), so a component removed from `source/` ORPHANS in the
    // graph. A `fullRebuild` (truncate + re-import) drops it — but only when the
    // source is AUTHORITATIVE and COMPLETE this run, or we'd wipe live data:
    //   - `noPull`: the user controls `source/`; there is no `sf project retrieve`
    //     that could flakily return fewer types (a partial pull + truncate = loss).
    //   - `requestedTypes === null`: a FULL refresh. A scoped `--types Flow` run
    //     only extracted Flows, so truncating would wipe every other type.
    //   - no extraction `failures`: a file that failed to parse is absent from
    //     `results`; truncating would drop its node on a transient parse error.
    // A full, clean, no-pull rebuild is byte-identical to the upsert result when
    // nothing was deleted (P10-A7), and correctly drops what was. A with-pull
    // full refresh with zero failures uses the same path once source/ is
    // reconciled against the authoritative retrieve set (P15-VAULT-a7b).
    const sourceAuthoritative =
      opts.noPull === true && requestedTypes === null && failures.length === 0;
    const pullFullyAuthoritative =
      opts.noPull !== true &&
      requestedTypes === null &&
      failures.length === 0 &&
      reconciledTypes !== undefined &&
      reconciledTypes.size > 0;
    if (sourceAuthoritative || pullFullyAuthoritative) {
      return fullRebuild(store, results);
    }
    if (reconciledTypes !== undefined && reconciledTypes.size > 0) {
      // Scoped/pruned WITH-PULL reconcile. The fresh rows of the reconciled
      // type(s) are upserted by `importExtractionResults` first (its own per-batch
      // transactions). Then prune ONLY the stale rows of those SAME reconciled
      // types: `computeChangeSet({ pruneNodeTypes })` returns delete lists already
      // type-scoped (a delete entry's node/edge endpoint type ∈ `reconciledTypes`),
      // so a surviving, never-re-extracted type can never appear in them.
      //
      // CR-20: this prunes via `pruneStaleNodes` (chunked DELETE transactions),
      // NOT `applyChangeSet`. `applyChangeSet`'s whole-graph post-apply self-check
      // compares the GLOBAL row count to a reconciled-ONLY desired count, which is
      // wrong for a partial reconcile — on any multi-type graph it tripped, rolled
      // back, and orphaned the stale rows (and hard-failed this refresh). The
      // chunked prune sidesteps that self-check and bounds memory per batch, so
      // INCREMENTAL_DELTA_CAP is INFORMATIONAL on this branch only: an over-cap
      // scoped prune still runs in full (never no-ops, never a whole-graph rebuild
      // that would defeat the scope), because leaving orphans would corrupt the
      // vault.
      const imported = await importExtractionResults(store, results);
      if (!imported.ok) return imported;
      const csResult = await computeChangeSet(store, results, { pruneNodeTypes: reconciledTypes });
      if (!csResult.ok) return csResult;
      const delta = changeSetSize(csResult.value);
      if (delta === 0) return imported;
      if (delta > INCREMENTAL_DELTA_CAP) {
        progress(
          `Pulled reconcile: delta ${delta} rows exceeds cap ${INCREMENTAL_DELTA_CAP}; pruning in batches (scoped — full rebuild would defeat the scope).`,
        );
      }
      const pruned = await pruneStaleNodes(store, csResult.value);
      if (!pruned.ok) return pruned;
      progress(
        `Pulled reconcile: dropped ${pruned.value.nodesDeleted} stale node(s) and ${pruned.value.edgesDeleted} stale edge(s) for reconciled type(s).`,
      );
      return imported;
    }
    return importExtractionResults(store, results);
  }

  const csResult = await computeChangeSet(store, results);
  if (!csResult.ok) {
    progress(
      `Incremental graph: diff read failed (${csResult.error.message}); rebuilding full.`,
    );
    return fullRebuild(store, results);
  }
  const cs = csResult.value;
  const delta = changeSetSize(cs);
  if (delta > INCREMENTAL_DELTA_CAP) {
    progress(
      `Incremental graph: delta ${delta} rows exceeds cap ${INCREMENTAL_DELTA_CAP}; rebuilding full.`,
    );
    return fullRebuild(store, results);
  }

  const applied = await applyChangeSet(store, cs);
  if (!applied.ok) {
    progress(
      `Incremental graph: apply failed (${applied.error.message}); rebuilding full.`,
    );
    return fullRebuild(store, results);
  }
  progress(
    `Incremental graph: ${applied.value.nodesUpserted} node + ${applied.value.edgesUpserted} edge upserts, ` +
      `${applied.value.nodesDeleted} + ${applied.value.edgesDeleted} deletes (cold-identical).`,
  );
  return applied;
};

/**
 * Run the import → render → patterns → manifest stages with the graph
 * already open. Extracted from `runRefresh` so the open/close lifecycle
 * is a single try/finally; this body may throw, and the outer scope will
 * still close the store before propagating.
 */
const persistResolveIndexBestEffort = async (
  graphDbPath: string,
  store: GraphStore,
): Promise<void> => {
  try {
    await persistResolveIndexArtifact(graphDbPath, store);
  } catch {
    // Non-fatal — resolve rebuilds the index in-process on miss.
  }
};

const runWithOpenGraph = async (args: RunWithOpenGraphArgs): Promise<RefreshResult> => {
  const { store, paths, started, targetOrg, walked, opts, requestedTypes, confirmedTypes } = args;
  const progress = opts.onProgress ?? (() => {});
  if (args.publishOnly === true && opts.stagedMarker === undefined) {
    await persistResolveIndexBestEffort(paths.graphDb, store);
  }
  if (args.publishOnly !== true) {
    const importResult = await importGraph(
      store,
      walked.results,
      opts,
      requestedTypes,
      walked.failures,
      progress,
      args.reconciledTypes,
    );
    if (!importResult.ok) {
      return failed(
        started,
        `importExtractionResults: ${importResult.error.message}`,
        walked.failures,
        EMPTY_COUNTS,
        walked.skippedDirectories,
      );
    }
    if (opts.stagedMarker === undefined) {
      await persistResolveIndexBestEffort(paths.graphDb, store);
    }
  }

  // Data-shape capture is graph state, not a rendered artifact. Run it during
  // the off-to-the-side build so those facts are part of the installed file.
  if (opts.withDataShape === true && args.buildOnly === true) {
    try {
      const shape = await captureDataShape(store, targetOrg);
      if (shape.ran) {
        console.error(
          `Data shape: ${shape.recordCountFacts} record counts + ${shape.fillRateFacts} fill rates captured (${shape.apiCalls}/${shape.budget} API calls${shape.budgetExhausted ? ', budget exhausted — partial' : ''})`,
        );
      } else {
        console.error(`Data shape: skipped — ${shape.skippedReason ?? 'unknown reason'}`);
      }
    } catch {
      // Non-fatal — the offline vault is coherent without facts.
    }
  }

  // v1.7 R2: optional Tooling API enrichment. On a side-build this belongs to
  // phase 1 because it mutates the graph; phase 2 carries its summary forward.
  let toolingApiSummary = args.toolingApiSummary;
  if (opts.withToolingApi === true && args.buildOnly === true) {
    toolingApiSummary = await runToolingApiEnrichment(store, targetOrg, opts);
  }

  if (args.buildOnly === true) {
    const counted = await countGraphTotals(store);
    if (!counted.ok) {
      return failed(started, `countGraphTotals: ${counted.error}`, walked.failures, EMPTY_COUNTS, walked.skippedDirectories);
    }
    return {
      status: walked.failures.length === 0 && args.retrieveFailures.length === 0 ? 'success' : 'partial',
      counts: counted.value,
      skippedDirectories: walked.skippedDirectories,
      errors: walked.failures,
      durationMs: Date.now() - started,
      ...(args.retrieveFailures.length > 0 ? { retrieveFailures: args.retrieveFailures } : {}),
      ...(toolingApiSummary !== undefined ? { toolingApi: toolingApiSummary } : {}),
      ...(args.reportsCapStats !== undefined ? { reportsCap: args.reportsCapStats } : {}),
    };
  }

  // P13-STAGED-tiers: a mid-build tier carries a staged marker; it defers the
  // Markdown render and every post-render hook that presumes a complete graph.
  const midBuild = opts.stagedMarker !== undefined;

  let counts;
  if (opts.skipRender === true) {
    progress('Staged tier: Markdown render deferred to the final tier; counting graph...');
    const counted = await countGraphTotals(store);
    if (!counted.ok) {
      return failed(started, `countGraphTotals: ${counted.error}`, walked.failures, EMPTY_COUNTS, walked.skippedDirectories);
    }
    counts = counted.value;
  } else {
    progress('Rendering Markdown vault...');
    try {
      // Stream one "ComponentType: N" line per non-empty type as it's drained
      // (B11) so a long render isn't a silent wait; phase lines bracket it.
      counts = await renderVault(store, paths.root, (type, count) => {
        progress(`  ${type}: ${count}`);
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return failed(started, `renderVault: ${msg}`, walked.failures, EMPTY_COUNTS, walked.skippedDirectories);
    }
  }

  // Patterns are best-effort: the vault, graph, and manifest are already
  // coherent here, so a recognizer failure must not flip status. Deferred on
  // mid-build staged tiers — the final tier recognizes over the full graph.
  if (!opts.skipRender) await recognizeNamingConventions(store);

  // Normal refreshes enrich at the established point in the pipeline. A
  // side-build publish carries the phase-1 summary and must not query twice.
  if (
    opts.withToolingApi === true &&
    args.publishOnly !== true
  ) {
    toolingApiSummary = await runToolingApiEnrichment(store, targetOrg, opts);
  }

  const hashResult = await computeSourceTreeHash(paths.source);
  if (!hashResult.ok) {
    return failed(
      started,
      `computeSourceTreeHash: ${hashResult.error.message}`,
      walked.failures,
      counts,
      walked.skippedDirectories,
    );
  }

  // Build the extended manifest shape. The base `VaultManifest`
  // interface in `@sf-intelligence/contracts` is frozen and does not
  // know about `skippedDirectories`, so the field rides on the
  // vault-package extension. Older readers ignore unknown JSON keys
  // (no schema validation on read), so writing the field is backward-
  // compatible with vaults consumed by earlier sf-intelligence releases.
  // The map is always written — even when empty — so consumers can
  // distinguish "this vault used the counter and saw no skips" from
  // "this vault predates the counter".
  const coverage = decorateReportsCapCoverage(
    decoratePendingCoverage(
      buildCoverageEntries(
        counts,
        walked.skippedDirectories,
        requestedTypes,
        paths.source,
        walked.failures,
        confirmedTypes,
      ),
      opts.stagedMarker,
    ),
    args.reportsCapStats,
  );

  let phantomSummary: ExtendedVaultManifest['phantomSummary'];
  if (!midBuild && opts.stagedMarker === undefined) {
    try {
      const rolled = await computePhantomBucketSummary(store, (type) =>
        demandCoverageStatusOf({ coverage } as ExtendedVaultManifest, type),
      );
      phantomSummary = {
        computedAt: new Date().toISOString(),
        distinctPhantoms: rolled.distinctPhantoms,
        buckets: rolled.buckets,
      };
    } catch {
      // Non-fatal — architects can still run on-demand phantom tools.
    }
  }

  const manifest: ExtendedVaultManifest = {
    version: PACKAGE_VERSION,
    refreshedAt: new Date().toISOString(),
    sourceOrg: targetOrg,
    components: counts.components,
    edges: counts.edges,
    sourceTreeHash: hashResult.value,
    coverage,
    coverageComputedAt: new Date().toISOString(),
    skippedDirectories: walked.skippedDirectories,
    ...(opts.stagedMarker !== undefined ? { staged: opts.stagedMarker } : {}),
    ...(args.apexAstStats !== undefined ? { apexAst: args.apexAstStats } : {}),
    ...(args.reportsCapStats !== undefined ? { reportsCap: args.reportsCapStats } : {}),
    ...(phantomSummary !== undefined ? { phantomSummary } : {}),
    ...(toolingApiSummary !== undefined && toolingApiSummary.enrichedCount > 0
      ? {
          toolingApiEnrichedAt: new Date().toISOString(),
          toolingApiEnrichmentScope: [...TOOLING_API_ENRICHED_TYPES],
        }
      : {}),
  };
  // Diff against the previous manifest BEFORE saveManifest overwrites it.
  // Skipped mid-staged-build: a tier's partial counts would record bogus
  // deltas in the history/pulse timeline.
  let changeSummary: ChangeSummary | undefined;
  if (!midBuild) {
    const previousManifest = await loadManifest(paths.root);
    changeSummary = computeChangeSummary(
      previousManifest.ok ? previousManifest.value : null,
      manifest,
    );
  }

  const saved = await saveManifest(paths.root, manifest);
  if (!saved.ok) {
    return failed(
      started,
      `saveManifest: ${saved.error.message}`,
      walked.failures,
      counts,
      walked.skippedDirectories,
    );
  }

  if (!midBuild) {
    try {
      const { vaultGitEnabled } = await import('./vault-git.js');
      if (!vaultGitEnabled(paths.root)) {
        progress(
          'Vault git history disabled — run `sfi vault git enable` for component_history / component_as_of',
        );
      }
    } catch {
      // non-fatal adoption nudge
    }
  }

  // Continuous-learning store + pulse: skipped mid-staged-build (partial
  // counts would pollute the timeline); the final tier writes both normally.
  let pulse: RefreshPulse | undefined;
  if (!midBuild && changeSummary !== undefined) {
    // Append this refresh's deltas to the history log so answers can reason
    // over "what was true before + what changed". Non-fatal on write failure.
    await appendRefreshHistory(paths.meta, manifest, changeSummary);

    // P13-GITHIST-enable: when the vault keeps its own git history AND the
    // source tree actually changed, auto-commit the new state with a delta
    // summary. Best-effort by contract; non-enabled vaults are a no-op.
    if (changeSummary.sourceTreeHashChanged) {
      try {
        const deltas = Object.entries(changeSummary.componentDeltas)
          .slice(0, 6)
          .map(([type, d]) => `${d > 0 ? '+' : ''}${d} ${type}`)
          .join(', ');
        const { autoCommitVaultGit } = await import('./vault-git.js');
        const committed = autoCommitVaultGit(
          paths.root,
          `sfi refresh ${manifest.refreshedAt} — ${deltas.length > 0 ? deltas : 'source changed, counts stable'}`,
        );
        if (committed.committed) progress(`Vault git: ${committed.detail}`);
      } catch {
        // never fail a refresh over history bookkeeping
      }
    }

    // Refresh-completion pulse (P9-refresh-pulse): interpret the change summary
    // and persist it best-effort to the gitignored `org-kb/meta/pulse.json` so a
    // scheduled digest / tooling can read the last refresh's headline. The pulse
    // rides on the in-memory result regardless of whether this write succeeds.
    pulse = buildRefreshPulse(changeSummary);

    // P13-ANNOT-store: annotations are keyed by component id and survive the
    // refresh — but their SUBJECT may not. Report orphans (annotated ids no
    // longer in the fresh graph) in the pulse so a human re-points or unsets
    // them. Best-effort; annotation-free vaults add nothing to the pulse.
    const orphans = await findAnnotationOrphans(store, paths.root);
    if (orphans.length > 0) {
      pulse = {
        ...pulse,
        annotationOrphans: orphans,
        highlights: [
          ...pulse.highlights,
          `${orphans.length} annotation(s) point at component(s) no longer in the graph — re-point or unset (sfi annotate): ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', …' : ''}`,
        ],
      };
    }
    try {
      await writeFile(
        join(paths.meta, 'pulse.json'),
        `${JSON.stringify(pulse, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Non-fatal — same posture as the history-log write above.
    }
  }

  // Refresh epoch (P13-WATCH-epoch): bump the marker an open MCP server
  // watches so it reopens its read connection — retiring the
  // restart-after-refresh / stale-loaded-vault class. Best-effort.
  try {
    await writeFile(join(paths.meta, 'refresh-epoch'), `${manifest.refreshedAt}\n`, 'utf8');
  } catch {
    // non-fatal — the vault is coherent; an open server just won't hot-reload
  }

  // Risk scores, onboarding handbook, and org card all presume a complete
  // graph — deferred on mid-build staged tiers to the final tier.
  if (!midBuild) {
    // Score-at-refresh (P9-risk-delta): run the real scorer against the open
    // graph and log the score for the tech_debt_score delta. Best-effort.
    await appendRiskScores(paths.meta, paths.root, manifest, store);

    // Auto-onboarding handbook (P9-auto-onboarding-doc): regenerate it from the
    // fresh graph into the gitignored docs/onboarding.md. Best-effort.
    await writeOnboardingDoc(paths.root, manifest, store);

    // Org card (P13-CARD-render): the ≤16KB orientation document an AI loads
    // before its first question — docs/org-card.md + meta/org-card.json,
    // regenerated from the fresh graph. Best-effort.
    await writeOrgCard(paths.root, paths.meta, manifest, store);
  }

  // Normal refreshes keep the established post-publish capture ordering.
  // Side-builds already captured into the replacement graph in phase 1.
  if (
    opts.withDataShape === true &&
    args.publishOnly !== true
  ) {
    try {
      const shape = await captureDataShape(store, targetOrg);
      if (shape.ran) {
        console.error(
          `Data shape: ${shape.recordCountFacts} record counts + ${shape.fillRateFacts} fill rates captured (${shape.apiCalls}/${shape.budget} API calls${shape.budgetExhausted ? ', budget exhausted — partial' : ''})`,
        );
      } else {
        console.error(`Data shape: skipped — ${shape.skippedReason ?? 'unknown reason'}`);
      }
    } catch {
      // Non-fatal — the offline vault is coherent without facts.
    }
  }

  if (args.snapshotOnRefresh && !midBuild) {
    const label = `refresh-${manifest.refreshedAt.replace(/[:.]/g, '-')}`;
    const snap = await runSnapshotCreate({ cwd: args.opts.cwd, label });
    if (!snap.ok && snap.error.kind !== 'snapshot-exists') {
      // Snapshot history is best-effort; the vault is already coherent.
      process.stderr.write(
        `sfi refresh: snapshot skipped (${snap.error.message})\n`,
      );
    }
  }

  return {
    status: walked.failures.length === 0 && args.retrieveFailures.length === 0 ? 'success' : 'partial',
    counts,
    skippedDirectories: walked.skippedDirectories,
    errors: walked.failures,
    durationMs: Date.now() - started,
    ...(args.retrieveFailures.length > 0 ? { retrieveFailures: args.retrieveFailures } : {}),
    ...(changeSummary !== undefined ? { changeSummary } : {}),
    ...(pulse !== undefined ? { pulse } : {}),
    ...(toolingApiSummary !== undefined ? { toolingApi: toolingApiSummary } : {}),
    ...(args.reportsCapStats !== undefined ? { reportsCap: args.reportsCapStats } : {}),
  };
};

/**
 * Append one line to the vault's continuous-learning history log
 * (`meta/history.jsonl`). Each refresh records its timestamp, source hash,
 * whether the org changed, and the per-type component/edge deltas — the
 * timeline `sfi.org_history` reads to answer "what was true before + what
 * changed". Non-fatal: history is a convenience layer, not vault integrity.
 */
const appendRefreshHistory = async (
  metaDir: string,
  manifest: ExtendedVaultManifest,
  changeSummary: ChangeSummary,
): Promise<void> => {
  const totalComponents = Object.values(manifest.components).reduce<number>((a, b) => a + (b ?? 0), 0);
  const record = {
    refreshedAt: manifest.refreshedAt,
    sourceTreeHash: manifest.sourceTreeHash,
    sourceTreeHashChanged: changeSummary.sourceTreeHashChanged,
    componentDeltas: changeSummary.componentDeltas,
    edgeDeltas: changeSummary.edgeDeltas,
    totalComponents,
  };
  try {
    await appendFile(join(metaDir, 'history.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Non-fatal.
  }
};

/** One appended row in the gitignored `meta/risk-scores.jsonl` (P9-risk-delta). */
interface RiskScoreEntry {
  readonly refreshedAt: string;
  readonly sourceTreeHash: string;
  readonly techDebtScore: number | null;
}

/**
 * Best-effort: run the REAL tech-debt scorer against the just-built graph and
 * append its 0-100 score to `meta/risk-scores.jsonl`, so `sfi.tech_debt_score`
 * can report the signed delta vs the prior refresh (P9-risk-delta).
 * Score-at-refresh is the ONLY way to a real delta — snapshots persist property
 * HASHES, not the properties the scorer reads, so a prior graph cannot be
 * reconstructed to re-score on demand. Same posture as the history log: a
 * scorer or write failure never affects the refresh (it reuses the already-open
 * graph, so there is no second graph open and no lock conflict).
 */
const appendRiskScores = async (
  metaDir: string,
  vaultRoot: string,
  manifest: ExtendedVaultManifest,
  store: GraphStore,
): Promise<void> => {
  try {
    const ctx: McpContext = { vaultRoot, manifest, graph: store };
    const result = await dispatchTool(ctx, 'sfi.tech_debt_score', {});
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    const parsed =
      typeof text === 'string'
        ? (JSON.parse(text) as { data?: { overallScore?: unknown } })
        : undefined;
    const raw = parsed?.data?.overallScore;
    const entry: RiskScoreEntry = {
      refreshedAt: manifest.refreshedAt,
      sourceTreeHash: manifest.sourceTreeHash,
      techDebtScore: typeof raw === 'number' ? raw : null,
    };
    await appendFile(
      join(metaDir, 'risk-scores.jsonl'),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    );
  } catch {
    // Non-fatal — the risk-delta is a convenience layer over the refresh.
  }
};

/**
 * Best-effort (P9-auto-onboarding-doc): regenerate the onboarding handbook from
 * the freshly-built graph and write it under the gitignored `docs/onboarding.md`
 * so a new hire always has a current handbook after a refresh. Reuses the open
 * graph (no second open / lock). A generator or write failure never affects the
 * refresh — the handbook is a convenience layer over the vault.
 */
const writeOnboardingDoc = async (
  vaultRoot: string,
  manifest: ExtendedVaultManifest,
  store: GraphStore,
): Promise<void> => {
  try {
    const ctx: McpContext = { vaultRoot, manifest, graph: store };
    const result = await dispatchTool(ctx, 'sfi.generate_onboarding_doc', {});
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    const parsed =
      typeof text === 'string'
        ? (JSON.parse(text) as {
            data?: {
              document?: {
                frontmatter?: { generatedAt?: unknown };
                body?: unknown;
              };
            };
          })
        : undefined;
    const doc = parsed?.data?.document;
    const body = doc?.body;
    if (typeof body !== 'string' || body.length === 0) return;
    const generatedAt =
      typeof doc?.frontmatter?.generatedAt === 'string'
        ? doc.frontmatter.generatedAt
        : manifest.refreshedAt;
    const md = `<!-- onboarding handbook · generated ${generatedAt} · source ${manifest.sourceTreeHash} -->\n${body}\n`;
    const docsDir = join(vaultRoot, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'onboarding.md'), md, 'utf8');
  } catch {
    // Non-fatal — same best-effort posture as the pulse / risk-score writes.
  }
};

/**
 * Org-card refresh hook (P13-CARD-render): derive every card number from the
 * fresh graph/manifest (`buildOrgCardInput`), render the ≤16KB card with the
 * pure renderer, and write `docs/org-card.md` + `meta/org-card.json`.
 * Best-effort: a card failure never flips refresh status. The wall-clock
 * stamp lands in frontmatter/JSON only — the body is a deterministic
 * function of the graph (×3 renders are byte-identical).
 */
const writeOrgCard = async (
  vaultRoot: string,
  metaDir: string,
  manifest: ExtendedVaultManifest,
  store: GraphStore,
): Promise<void> => {
  try {
    const input = await buildOrgCardInput(manifest, store, manifest.refreshedAt);
    const card = renderOrgCard(input);
    const md = `---\n${serializeFrontmatter(card.frontmatter)}\n---\n\n${card.body}\n`;
    const docsDir = join(vaultRoot, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'org-card.md'), md, 'utf8');
    await writeFile(
      join(metaDir, 'org-card.json'),
      `${JSON.stringify(card.json, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Non-fatal — same best-effort posture as the onboarding-doc write.
  }
};

/** Signed deltas between two count maps; keeps nonzero entries only. */
const diffCounts = (
  before: Readonly<Record<string, number | undefined>>,
  after: Readonly<Record<string, number | undefined>>,
): Record<string, number> => {
  const deltas: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) deltas[key] = delta;
  }
  return deltas;
};

/**
 * Diff the new manifest against the previous one into a {@link ChangeSummary}.
 * A null `previous` (first refresh) yields `previousRefreshedAt: null` and a
 * changed source tree, so the formatter renders the first-refresh case.
 *
 * @example
 *   computeChangeSummary(prev, next).componentDeltas // => { Flow: +3, ApexClass: -1 }
 */
/** Sum a count map, treating missing/undefined entries as 0. */
const sumCounts = (counts: Readonly<Record<string, number | undefined>>): number =>
  Object.values(counts).reduce<number>((acc, n) => acc + (n ?? 0), 0);

/** Top-line counts for one metric: previous total, current total, signed delta. */
const metricCounts = (
  previous: Readonly<Record<string, number | undefined>>,
  next: Readonly<Record<string, number | undefined>>,
): GraphMetricCounts => {
  const prev = sumCounts(previous);
  const cur = sumCounts(next);
  return { previous: prev, current: cur, delta: cur - prev };
};

/** Format a signed delta with an explicit `+` for positives. */
const signedDelta = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/**
 * Compose a {@link RefreshPulse} from a {@link ChangeSummary} (P9-refresh-pulse).
 * The first highlight is always the graph headline; the rest are per-domain
 * watch-lines added only when that domain actually moved, each routing to the
 * deep tool a human should run next.
 */
/**
 * P13-ANNOT-store: annotated component ids with no node in the fresh graph.
 * Bounded by the number of DISTINCT annotated ids (one indexed lookup each);
 * any read failure yields an empty report — orphan detection is advisory.
 */
const findAnnotationOrphans = async (
  store: GraphStore,
  vaultRoot: string,
): Promise<readonly string[]> => {
  try {
    const annotations = await readAnnotations(vaultRoot);
    const ids = [...new Set(annotations.map((a) => a.componentId))];
    const orphans: string[] = [];
    for (const id of ids) {
      const node = await getNodeById(store, id as ComponentId);
      if (node.ok && node.value === null) orphans.push(id);
    }
    return orphans.sort();
  } catch {
    return [];
  }
};

export const buildRefreshPulse = (cs: ChangeSummary): RefreshPulse => {
  const cd = cs.componentDeltas;
  const at = (type: string): number => cd[type] ?? 0;
  const highlights: string[] = [
    `Graph ${signedDelta(cs.graphMetrics.components.delta)} components, ${signedDelta(cs.graphMetrics.edges.delta)} edges since the last refresh.`,
  ];
  if (at('Flow') !== 0) {
    highlights.push(
      `Flows ${signedDelta(at('Flow'))} — review the new/changed automation (sfi.explain_flow, sfi.what_happens_on_save).`,
    );
  }
  if (at('CustomField') > 0) {
    highlights.push(
      `CustomField +${at('CustomField')} — new fields can carry PII; run sfi.pii_inventory.`,
    );
  }
  const codeGrowth = at('ApexClass') + at('ApexTrigger') + at('Flow');
  if (codeGrowth > 0) {
    highlights.push(
      `Automation/code grew (${signedDelta(at('ApexClass'))} ApexClass, ${signedDelta(at('ApexTrigger'))} ApexTrigger, ${signedDelta(at('Flow'))} Flow) — check governor headroom (sfi.governor_limit_risks).`,
    );
  }
  if (highlights.length === 1) {
    highlights.push('No new Flows, fields, or Apex — nothing flagged for review.');
  }
  return {
    graphMetrics: cs.graphMetrics,
    componentDeltas: cd,
    edgeDeltas: cs.edgeDeltas,
    highlights,
  };
};

export const computeChangeSummary = (
  previous: VaultManifest | null,
  next: VaultManifest,
): ChangeSummary => ({
  previousRefreshedAt: previous?.refreshedAt ?? null,
  sourceTreeHashChanged: previous === null || previous.sourceTreeHash !== next.sourceTreeHash,
  componentDeltas: diffCounts(previous?.components ?? {}, next.components),
  edgeDeltas: diffCounts(previous?.edges ?? {}, next.edges),
  graphMetrics: {
    components: metricCounts(previous?.components ?? {}, next.components),
    edges: metricCounts(previous?.edges ?? {}, next.edges),
  },
});

/**
 * Set of ComponentTypes the v1.7 R2 Tooling API dispatch table covers
 * (per `docs/vendor/salesforce-metadata/ToolingApi.md` §"Per-type queries").
 * The enrichment pass loops over this list, queries each type's
 * freshness columns in batches, and folds the rows back into the
 * graph as patched node properties.
 */
const TOOLING_API_ENRICHED_TYPES = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'Layout',
  'CustomField',
  'ValidationRule',
] as const satisfies readonly ComponentType[];

/**
 * Drive the v1.7 R2 enrichment pass against the open graph. Returns a
 * structured `ToolingApiRefreshSummary` regardless of outcome so the
 * CLI can render the live-data axis as a separate block. Authentication
 * failures, malformed responses, and per-type query errors all surface
 * here without flipping the overall refresh status (the offline vault
 * is the source of truth; the enrichment is additive).
 */
const runToolingApiEnrichment = async (
  store: GraphStore,
  targetOrg: string,
  opts: RunRefreshOptions,
): Promise<ToolingApiRefreshSummary> => {
  let client: ToolingApiClient;
  if (opts.toolingApiClient !== undefined) {
    client = opts.toolingApiClient;
  } else {
    const authResult = await getAuthFromSfCli(targetOrg);
    if (!authResult.ok) {
      return {
        enrichedCount: 0,
        errorCount: 0,
        outcome: authResult.error.kind,
        fatalMessage: authResult.error.message,
      };
    }
    try {
      client = createToolingApiClient({ auth: authResult.value });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return {
        enrichedCount: 0,
        errorCount: 0,
        outcome: 'client-init-failed',
        fatalMessage: msg,
      };
    }
  }

  // Materialise the in-memory candidates by re-reading from the graph.
  // This avoids holding the full Node set in memory across the offline
  // pipeline — the enrichment runs after import/render so the graph is
  // the canonical store.
  const candidates: Node[] = [];
  for (const type of TOOLING_API_ENRICHED_TYPES) {
    const nodesResult = await listNodesByType(store, type, { limit: 500 });
    if (!nodesResult.ok) continue;
    candidates.push(...nodesResult.value);
  }
  if (candidates.length === 0) {
    return {
      enrichedCount: 0,
      errorCount: 0,
      outcome: 'no-enrichable-nodes',
    };
  }

  let enrichmentResult: EnrichmentResult;
  try {
    enrichmentResult = await enrichLastModified(
      {
        client,
        types: TOOLING_API_ENRICHED_TYPES,
      },
      candidates,
    );
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return {
      enrichedCount: 0,
      errorCount: 0,
      outcome: 'enrichment-threw',
      fatalMessage: msg,
    };
  }

  // Merge enrichments back into the graph. Build one re-import batch
  // that overlays `properties.lastModifiedDate` /
  // `properties.lastModifiedBy` / `properties.apiVersion` plus the
  // top-level `lastModifiedDate` / `lastModifiedBy` / `apiVersion`
  // columns on each affected node. `INSERT OR REPLACE` semantics in
  // the graph layer turn this into a row-level overwrite.
  if (enrichmentResult.enrichedCount > 0) {
    const byId = new Map<string, Node>();
    for (const node of candidates) byId.set(node.id, node);

    const patchedNodes: Node[] = [];
    for (const enrichment of enrichmentResult.enrichments) {
      const node = byId.get(enrichment.componentId);
      if (node === undefined) continue;
      const properties = {
        ...node.properties,
        lastModifiedDate: enrichment.lastModifiedDate,
        lastModifiedBy: enrichment.lastModifiedBy,
        ...(enrichment.apiVersion !== null ? { apiVersion: enrichment.apiVersion } : {}),
      };
      patchedNodes.push({
        ...node,
        lastModifiedDate: enrichment.lastModifiedDate,
        lastModifiedBy: enrichment.lastModifiedBy.id,
        apiVersion: enrichment.apiVersion ?? node.apiVersion,
        properties,
      });
    }
    if (patchedNodes.length > 0) {
      const overlay: ExtractionResult = { nodes: patchedNodes, edges: [] };
      const merged = await importExtractionResults(store, [overlay]);
      if (!merged.ok) {
        return {
          enrichedCount: 0,
          errorCount: enrichmentResult.errors.length,
          outcome: 'merge-failed',
          fatalMessage: merged.error.message,
        };
      }
    }
  }

  return {
    enrichedCount: enrichmentResult.enrichedCount,
    errorCount: enrichmentResult.errors.length,
    outcome: 'ok',
  };
};

/**
 * Load `org-kb/meta/config.json` and resolve the vault root. Returns a
 * human-readable message string on error for `fatalError`.
 */
export const loadVaultConfig = async (cwd: string): Promise<Result<VaultConfig, string>> => {
  const configPath = resolve(cwd, 'org-kb', 'meta', 'config.json');
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return err(`Vault config not found at ${configPath}. Run \`sfi init\` first.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw) as {
      targetOrg?: unknown;
      vaultRoot?: unknown;
      snapshotOnRefresh?: unknown;
    };
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : 'unknown';
    return err(`Vault config is not valid JSON: ${configPath} (${msg})`);
  }
  if (typeof parsed.targetOrg !== 'string' || parsed.targetOrg.length === 0) {
    return err(`Vault config missing 'targetOrg': ${configPath}`);
  }
  // Defense in depth (CR-01 / C1): this is the single chokepoint every refresh
  // path reads `targetOrg` through, so reject a poisoned alias here before it
  // can reach any `sf` call — even though the exec sites are now shell-free.
  if (!ORG_ALIAS_RE.test(parsed.targetOrg)) {
    return err(`Vault config 'targetOrg' is not a valid org alias: ${configPath}`);
  }
  const vaultRoot = typeof parsed.vaultRoot === 'string' && parsed.vaultRoot.length > 0
    ? parsed.vaultRoot
    : resolve(cwd, 'org-kb');
  const snapshotOnRefresh = parsed.snapshotOnRefresh !== false;
  return ok({ targetOrg: parsed.targetOrg, vaultRoot, snapshotOnRefresh });
};

/**
 * A handful of internal `ComponentType` names differ from the Metadata API
 * `xmlName` that a `package.xml` manifest and the org describe actually use.
 * Everything not listed here maps to itself.
 *
 * Getting these wrong silently drops the type at manifest-selection time: the
 * describe reports the API `xmlName`, we intersect against the internal name,
 * it never matches, and the type is skipped before retrieve ever runs. That is
 * why sharing rules and custom-metadata *records* must be aliased here — the
 * org exposes them as `SharingRules` / `CustomMetadata`, not the singular
 * record-level internal names. The folder→type mapping and the extractors for
 * both already exist, so aliasing the retrieve side is all that's needed for
 * them to flow end-to-end into the graph.
 */
const METADATA_API_NAME: Partial<Record<ComponentType, string>> = {
  VisualforcePage: 'ApexPage',
  VisualforceComponent: 'ApexComponent',
  // The four rule families below are exposed by the org ONLY as their plural
  // aggregate container xmlName (one file per object, e.g.
  // `Account.sharingRules-meta.xml`, `Case.assignmentRules-meta.xml`); the
  // singular internal ComponentType name is NOT a metadata type the describe
  // returns, so without the alias `selectManifestTypes` drops it and the
  // retrieve never pulls those rules into the vault (B20). Confirmed against a
  // real org `list metadata-types` describe: SharingRule / AssignmentRule /
  // AutoResponseRule / EscalationRule / MatchingRule are all ABSENT; only the
  // plural `*Rules` forms are PRESENT. (DuplicateRule, by contrast, IS exposed
  // singular and needs no alias.)
  SharingRule: 'SharingRules',
  AssignmentRule: 'AssignmentRules',
  AutoResponseRule: 'AutoResponseRules',
  EscalationRule: 'EscalationRules',
  MatchingRule: 'MatchingRules',
  // Workflow rules come down inside the `Workflow` container file
  // (`{Object}.workflow-meta.xml`, which the workflow-rule extractor reads);
  // the org describe exposes `Workflow`, not `WorkflowRule` (absent), so the
  // internal `WorkflowRule` type must alias to `Workflow` or it is dropped.
  WorkflowRule: 'Workflow',
  // Custom-metadata *records* (the rows of a `__mdt` type) are retrieved under
  // the `CustomMetadata` type as `{Type}.{Record}.md-meta.xml` files. The
  // `__mdt` type definitions themselves come down separately as CustomObject.
  CustomMetadataRecord: 'CustomMetadata',
  // CR-CAP-18: PlatformEventChannel / PlatformEventChannelMember are exposed
  // by the org describe under their own singular xmlNames (added API v45.0 /
  // v47.0), so they need NO alias — `toApiName` falls through to the type name.
  // PRE-SHIP VERIFY: confirm against a real-org `sf org list metadata-types`
  // that both are PRESENT singular (the B20 class above); add an alias here if
  // a describe shows otherwise. Not verifiable in this read-only pass.
};

/** Internal `ComponentType` → the Metadata API `xmlName` used in manifests / describe. */
const toApiName = (type: ComponentType): string => METADATA_API_NAME[type] ?? type;

/** Stdout ceiling for `sf` shellouts. Retrieve tables and the metadata-types describe both grow with org size. */
const SF_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Per-call timeout for a `sf project retrieve start`. Generous (10 min default)
 * because a full retrieve on a large org legitimately runs several minutes
 * (the refresh itself warns "this can take several minutes"). On timeout the
 * child is sent `SIGTERM` (graceful — lets `sf` clean up) so a hung/wedged
 * retrieve can never block a refresh or the unattended watch daemon forever
 * (CR-01 / H8). Override with `SFI_SF_RETRIEVE_TIMEOUT_MS`.
 */
const SF_RETRIEVE_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_RETRIEVE_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

/**
 * Per-call timeout for a `sf data query` / `sf org list metadata-types`
 * describe (2 min default). These are short read-only calls; a hung one must
 * not wedge the refresh (CR-01 / H8). Override with `SFI_SF_QUERY_TIMEOUT_MS`.
 */
const SF_QUERY_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_QUERY_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
})();

/**
 * The shell-free `sf` runner. Spawns the `sf` binary directly with an argv
 * array via `execFile` (NOT `exec`), so no value — including a `targetOrg` read
 * from `--target-org`/`config.json` — is ever interpreted by a shell (CR-01 /
 * C1): a metacharacter alias is one inert argv element, never executed. Every
 * `sf` call in this module routes through here. `exec` is injectable so tests
 * can assert the argv shape without spawning `sf`.
 *
 * @example runSf(['org', 'list', '--json'], { timeout: SF_QUERY_TIMEOUT_MS })
 */
export const runSf = (
  args: readonly string[],
  options: { readonly maxBuffer?: number; readonly cwd?: string; readonly timeout: number },
  exec: typeof execFileAsync = execFileAsync,
): Promise<{ stdout: string; stderr: string }> =>
  exec('sf', [...args], {
    maxBuffer: options.maxBuffer ?? SF_MAX_BUFFER,
    timeout: options.timeout,
    killSignal: 'SIGTERM',
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });

/**
 * Standard objects retrieved by explicit name. A `CustomObject` manifest with
 * `<members>*</members>` returns only CUSTOM objects, so standard objects
 * (Account, Contact, Case, …) never get a node — even when triggers/flows
 * target them. That left `what_happens_on_save` / `order_of_execution` unable
 * to answer for standard objects (they correctly refuse to compose a save
 * sequence around an object whose definition the vault doesn't hold). Naming
 * the commonly-automated standard objects pulls their `object-meta.xml` so
 * they become real, fully-modeled nodes. These objects exist in every org, so
 * naming them is safe; a standard object the org doesn't expose is skipped by
 * the retrieve rather than failing it.
 */
const STANDARD_OBJECTS_TO_MODEL: readonly string[] = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'Case',
  'Task',
  'Event',
  'Campaign',
  'Contract',
  'Asset',
  'Order',
  'Product2',
  'Pricebook2',
  'User',
];

/**
 * Manifest `<members>` for a type. Everything uses `*`; `CustomObject`
 * additionally names the standard objects (which `*` excludes) so automation
 * on Account/Contact/Case is modeled with real nodes.
 *
 * @example manifestMembersForType('CustomObject') // ['*', 'Account', 'Contact', ...]
 */
export const manifestMembersForType = (type: ComponentType): readonly string[] =>
  type === 'CustomObject' ? ['*', ...STANDARD_OBJECTS_TO_MODEL] : ['*'];

/**
 * FLD-05: after source extraction, enrich the five core standard objects with
 * CustomField nodes from a live `sobject describe` (fields that Metadata API
 * retrieve does not emit as `.field-meta.xml`). Best-effort — failures are
 * non-fatal and the refresh continues with source-only fields.
 */
export const appendStandardObjectDescribeFields = async (
  targetOrg: string,
  walked: Awaited<ReturnType<typeof walkAndExtract>>,
  progress: (message: string) => void,
): Promise<Awaited<ReturnType<typeof walkAndExtract>>> => {
  const existingIds = existingCustomFieldIds(walked.results);
  const existingById = existingCustomFieldNodes(walked.results);
  const objectIds = new Set(
    walked.results.flatMap((r) => r.nodes.map((n) => n.id)),
  );
  const snapshots: ExtractionResult[] = [];

  for (const objectApiName of STANDARD_OBJECT_FIELD_SNAPSHOT) {
    const objectId = `CustomObject:${objectApiName}`;
    if (!objectIds.has(objectId)) continue;

    const parsed = await runSfJson(targetOrg, [
      'sobject',
      'describe',
      '--sobject',
      objectApiName,
    ]);
    if (!parsed.ok) {
      progress(
        `Standard-field describe for ${objectApiName} skipped (non-fatal): ${parsed.error.message}`,
      );
      continue;
    }
    const payload = parsed.value as {
      result?: {
        fields?: readonly {
          name: string;
          label?: string;
          type?: string;
          custom?: boolean;
          nillable?: boolean;
          inlineHelpText?: string;
          picklistValues?: readonly { value?: string; label?: string; active?: boolean }[];
        }[];
      };
      fields?: readonly {
        name: string;
        label?: string;
        type?: string;
        custom?: boolean;
        nillable?: boolean;
        inlineHelpText?: string;
        picklistValues?: readonly { value?: string; label?: string; active?: boolean }[];
      }[];
    };
    const describe = payload.result ?? payload;
    const snap = buildDescribeFieldExtraction(objectApiName, describe, existingById);
    for (const node of snap.nodes) existingIds.add(node.id);
    if (snap.nodes.length > 0) snapshots.push(snap);
  }

  const overlay = mergeDescribeFieldSnapshots(snapshots);
  if (overlay.nodes.length === 0) return walked;

  progress(
    `Describe snapshot: ${overlay.nodes.length} standard-field node(s) enriched for ${STANDARD_OBJECT_FIELD_SNAPSHOT.join(', ')}.`,
  );
  return { ...walked, results: [...walked.results, overlay] };
};

/**
 * Edge types that mean "your automation / code actually touches this object" —
 * a trigger fires on it, Apex/Flow reads or writes its records, code references
 * it, it dispatches async, listens to an event, or fires a condition.
 *
 * `grantedBy` (permission grants) and `parentOf` (containment) are deliberately
 * EXCLUDED. A Profile blanket-grants object permissions on hundreds of obscure
 * platform/system objects and managed-package objects you never analyse;
 * auto-pulling every grant target would bloat the vault with 700+ objects. The
 * phantom DISCLOSURE handles those honestly instead — auto-expansion is only for
 * objects your own automation depends on.
 */
const AUTOMATION_EDGE_TYPES: ReadonlySet<string> = new Set([
  'triggersOn',
  'readsFrom',
  'writesTo',
  'references',
  'callsApex',
  'dispatchesAsync',
  'listensTo',
  'firesWhen',
]);

/**
 * Compute the CustomObjects to ADD to a second retrieve pass (B29): objects
 * your automation/code references (an `AUTOMATION_EDGE_TYPES` edge targets
 * `CustomObject:X`) that the first pass did NOT retrieve (no node — a phantom).
 *
 * The `<members>*</members>` CustomObject retrieve excludes managed objects and
 * standard objects, so a trigger/flow on a managed object or a single-underscore-
 * prefixed custom object (e.g. an admissions-template package) leaves it a
 * phantom; this names it explicitly so the second pass pulls it and the analysis
 * is not left with a hole. Returns sorted, de-duplicated API names; empty when
 * nothing automation-relevant is missing.
 */
export const objectsToExpandManifest = (
  results: readonly ExtractionResult[],
): readonly string[] => {
  const nodeIds = new Set<string>();
  for (const result of results) {
    for (const node of result.nodes) nodeIds.add(node.id);
  }
  const missing = new Set<string>();
  for (const result of results) {
    for (const edge of result.edges) {
      if (!AUTOMATION_EDGE_TYPES.has(edge.edgeType)) continue;
      if (!edge.toId.startsWith('CustomObject:')) continue;
      if (nodeIds.has(edge.toId)) continue;
      missing.add(edge.toId.slice('CustomObject:'.length));
    }
  }
  return [...missing].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/** Construct a package.xml in memory from the given (already API-named) types. */
const buildPackageXml = (types: readonly ComponentType[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...types.flatMap((type) => [
      '  <types>',
      ...manifestMembersForType(type).map((m) => `    <members>${m}</members>`),
      `    <name>${toApiName(type)}</name>`,
      '  </types>',
    ]),
    `  <version>${SF_API_VERSION}</version>`,
    '</Package>',
    '',
  ].join('\n');

/**
 * Best-effort probe of the metadata types the target org actually exposes,
 * via `sf org list metadata-types --json`. Returns the set of supported
 * `xmlName`s (including child types), or `null` if the describe is
 * unavailable — never throws. This is what lets a single `sfi refresh` adapt
 * to any org shape (edu, Health Cloud, OmniStudio) instead of demanding the
 * full superset and failing with `INVALID_TYPE`.
 */
const getOrgSupportedTypes = async (targetOrg: string): Promise<ReadonlySet<string> | null> => {
  try {
    const { stdout } = await runSf(
      ['org', 'list', 'metadata-types', '--target-org', targetOrg, '--json'],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_QUERY_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as {
      result?: { metadataObjects?: ReadonlyArray<{ xmlName?: string; childXmlNames?: readonly string[] }> };
    };
    const names = new Set<string>();
    for (const obj of parsed.result?.metadataObjects ?? []) {
      if (typeof obj.xmlName === 'string') names.add(obj.xmlName);
      for (const child of obj.childXmlNames ?? []) {
        if (typeof child === 'string') names.add(child);
      }
    }
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
};

/** Result of narrowing the supported types down to what should go in the manifest. */
export interface ManifestTypeSelection {
  /** Types that will be written into the retrieve manifest. */
  readonly included: readonly ComponentType[];
  /** Types removed because the org does not expose them (empty when the describe is unavailable). */
  readonly dropped: readonly ComponentType[];
}

/**
 * Pure type-selection step for the retrieve manifest. Starts from the
 * supported set, narrows it by `--types` (when supplied), then — when the org
 * describe is available — intersects with the types the org actually exposes
 * so the retrieve never asks for a type that would raise `INVALID_TYPE`. With
 * no describe (`orgTypes === null`) the candidates pass through unchanged,
 * preserving the legacy "request everything" behaviour.
 *
 * @example
 *   selectManifestTypes(new Set(['ApexTrigger', 'OmniScript']), new Set(['ApexTrigger']))
 *   // => { included: ['ApexTrigger'], dropped: ['OmniScript'] }
 */
export const selectManifestTypes = (
  requestedTypes: ReadonlySet<ComponentType> | null,
  orgTypes: ReadonlySet<string> | null,
): ManifestTypeSelection => {
  const candidates: readonly ComponentType[] =
    requestedTypes !== null ? SUPPORTED_TYPES.filter((type) => requestedTypes.has(type)) : SUPPORTED_TYPES;
  if (orgTypes === null) return { included: candidates, dropped: [] };
  return {
    included: candidates.filter((type) => orgTypes.has(toApiName(type))),
    dropped: candidates.filter((type) => !orgTypes.has(toApiName(type))),
  };
};

/**
 * Shell out to `sf project retrieve start`. The manifest is generated at run
 * time from {@link selectManifestTypes}, so the retrieve never asks for a type
 * the org would reject. If the org describe is unavailable the full supported
 * set is used (legacy behaviour) with a warning. Errors collapse into a single
 * string the caller stores in `fatalError`.
 */
/** One metadata type the retrieve could not deliver, with the sf error behind it. */
export interface RetrieveTypeFailure {
  readonly type: ComponentType;
  readonly error: string;
}

interface SfRetrieveResult {
  /** Types that successfully landed on disk this run (the manifest minus failures). */
  readonly manifestTypes: readonly ComponentType[];
  readonly deletedCount: number;
  /** Types that failed mid-retrieve and were skipped so the rest could land. */
  readonly failures: readonly RetrieveTypeFailure[];
  /**
   * CR-P3-3: the set of types whose retrieve was CONFIRMED-CLEAN — the org
   * describe was non-null AND listed the type AND `sf project retrieve`
   * returned with no error. NULL when the describe probe failed (describe-blind
   * pull): we cannot prove the org supports any type, so a clean empty pull is
   * not trustworthy and NO type may read as confirmed-empty. Drives
   * `CoverageEntry.retrieveConfirmed`.
   */
  readonly confirmedTypes: ReadonlySet<ComponentType> | null;
}

/**
 * Classify a `sf project retrieve` failure. A `global` cause (auth, no DX
 * project, no target-org) cannot be fixed by retrieving fewer types, so the
 * fallback attributes it to the whole batch and stops. Everything else is
 * `per-type` and splittable: `INVALID_TYPE` / an entity the org rejects (split
 * until the culprit stands alone) AND a transient network/timeout error — which
 * on a large multi-type batch is usually load-induced, so splitting shrinks the
 * batch until it lands instead of aborting the whole refresh.
 *
 * @example classifyRetrieveError('ERROR: INVALID_TYPE: Cannot use OmniScript') // 'per-type'
 * @example classifyRetrieveError('socket hang up') // 'per-type' (split — smaller batches land)
 * @example classifyRetrieveError('No authorization information found') // 'global'
 */
export const classifyRetrieveError = (message: string): 'global' | 'per-type' => {
  // Only causes that retrieving FEWER types cannot fix are terminal-'global'.
  // Network/timeout is deliberately absent: a big combined retrieve that times
  // out usually succeeds once split into smaller batches, so it must be
  // splittable, not fatal (the bug that aborted refresh on large real orgs).
  const GLOBAL_SIGNALS: readonly RegExp[] = [
    /no authorization|not authorized|no auth information|expired access\/refresh token|invalid[_ ]grant/i,
    /org ?login|sfdx[_ ]?login|requires? you to (?:re-?)?authenticate|session expired/i,
    /does not contain a valid salesforce dx project/i,
    /no default (?:environment|org)|no target-?org|no org configured|requires a target org/i,
  ];
  return GLOBAL_SIGNALS.some((re) => re.test(message)) ? 'global' : 'per-type';
};

/** Split a type batch in half for the binary-search isolation of a bad type. */
export const splitTypeBatch = (
  types: readonly ComponentType[],
): readonly [readonly ComponentType[], readonly ComponentType[]] => {
  const mid = Math.floor(types.length / 2);
  return [types.slice(0, mid), types.slice(mid)];
};

/**
 * The most informative line of a (possibly multi-line) sf error. Node wraps a
 * non-zero exit as `Command failed: <cmd>` on line 0 and prints the real cause
 * (`Error (UnsafeFilepathError): …`, a timeout, an `INVALID_TYPE`) below it — so
 * line 0 alone hides every actionable failure (the gap that kept a real retrieve
 * bug invisible). Prefer a line that names the error; fall back to the first
 * non-`Command failed:` line, then the raw first line.
 */
const salientErrorLine = (error: string): string => {
  const lines = error.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const named = lines.find((l) => /^Error\b|Error \(|^ERROR\b|UnsafeFilepathError|INVALID_TYPE/.test(l));
  if (named !== undefined) return named;
  const nonWrapper = lines.find((l) => !l.startsWith('Command failed:'));
  return nonWrapper ?? lines[0] ?? error.trim();
};

/**
 * Render retrieve failures for a user-facing message. When every type failed for
 * the same reason (a shared global cause) the message states that reason once;
 * otherwise it lists each type with its own first-line error.
 */
export const summarizeRetrieveFailures = (
  failures: readonly RetrieveTypeFailure[],
): string => {
  if (failures.length === 0) return '';
  const uniqueReasons = new Set(failures.map((f) => salientErrorLine(f.error)));
  if (uniqueReasons.size === 1) {
    const [reason] = [...uniqueReasons];
    const [first] = failures;
    return failures.length === 1 && first !== undefined
      ? `${first.type}: ${reason}`
      : (reason ?? '');
  }
  return failures.map((f) => `${f.type} (${salientErrorLine(f.error)})`).join('; ');
};

/** Retrieve a batch of types: returns the reconcile `deletedCount`, or the sf error. */
export type RetrieveBatchFn = (
  types: readonly ComponentType[],
) => Promise<Result<{ readonly deletedCount: number }, string>>;

export interface RetrieveFallbackOutcome {
  /** Types that landed this run. */
  readonly succeeded: readonly ComponentType[];
  readonly deletedCount: number;
  readonly failures: readonly RetrieveTypeFailure[];
}

/**
 * Retrieve `allTypes`, degrading gracefully when one type poisons the manifest
 * OR when the full set is too large to retrieve in a single call. The first
 * attempt is the full set (the common case — one sf call). On failure it
 * binary-splits to isolate the bad type(s) — or, for a load-induced timeout, to
 * shrink the batch until it lands — keeping every type that succeeds and
 * recording each that does not, so a rejected type or an oversized batch yields a
 * partial vault instead of aborting the whole refresh. Only a `global` failure
 * (auth / no DX project / no target-org) is not split, since splitting cannot fix
 * it — so a dead-auth org costs one call, not `2N-1`. The sf shelling is injected
 * as `retrieveBatch`, keeping this decision logic pure and unit-testable.
 */
export const retrieveWithFallback = async (
  allTypes: readonly ComponentType[],
  retrieveBatch: RetrieveBatchFn,
): Promise<RetrieveFallbackOutcome> => {
  const succeeded: ComponentType[] = [];
  const failures: RetrieveTypeFailure[] = [];
  let deletedCount = 0;

  const attempt = async (types: readonly ComponentType[]): Promise<void> => {
    if (types.length === 0) return;
    const result = await retrieveBatch(types);
    if (result.ok) {
      succeeded.push(...types);
      deletedCount += result.value.deletedCount;
      return;
    }
    if (types.length === 1 || classifyRetrieveError(result.error) === 'global') {
      for (const type of types) failures.push({ type, error: result.error });
      return;
    }
    const [left, right] = splitTypeBatch(types);
    await attempt(left);
    await attempt(right);
  };

  await attempt(allTypes);
  return { succeeded, deletedCount, failures };
};

/**
 * Shell out to `sf project retrieve start` for one batch of types, then reconcile
 * deletions and merge the authoritative output into `sourceDir`. Reconciliation
 * is scoped to `types`, so a batch never deletes another batch's source.
 */
const retrieveTypeBatch = async (
  targetOrg: string,
  sourceDir: string,
  types: readonly ComponentType[],
): Promise<Result<{ readonly deletedCount: number }, string>> => {
  // Disjoint splits never share a first type, so this names temp paths uniquely
  // even when several batches start within the same millisecond.
  const stamp = `${Date.now()}-${types.length}-${types[0] ?? 'batch'}`;
  const manifestPath = join(tmpdir(), `sfi-refresh-package-${stamp}.xml`);
  // Retrieve into a fresh throwaway SFDX project — NOT a bare `--output-dir` run
  // from the vault. A bare temp output-dir run from the vault inherits the vault's
  // `.sf` source tracking, which reconciles the retrieved files against stale temp
  // paths and fails the WHOLE retrieve (`UnsafeFilepathError`, or
  // `MetadataTransferError: … does not contain a valid Salesforce DX project`) on
  // large multi-type batches — the bug that aborted refresh on real orgs. A
  // self-contained throwaway project (its own sfdx-project.json + an existing
  // package dir, with `sf` run from inside it) has clean tracking and a valid
  // project root, so the big combined retrieve lands. The retrieved source sits at
  // `${pkgDir}/main/default/…`, structurally identical to the old `--output-dir`
  // tree, so the reconcile/sync below are unchanged.
  const projectDir = join(tmpdir(), `sfi-retrieve-${stamp}`);
  const pkgDir = join(projectDir, 'force-app');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(projectDir, 'sfdx-project.json'),
    `{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"${SF_API_VERSION}"}\n`,
    'utf8',
  );
  await writeFile(manifestPath, buildPackageXml(types), 'utf8');
  try {
    await runSf(
      ['project', 'retrieve', 'start', '--manifest', manifestPath, '--target-org', targetOrg],
      { maxBuffer: SF_MAX_BUFFER, cwd: projectDir, timeout: SF_RETRIEVE_TIMEOUT_MS },
    );
    const reconcile = await reconcileSourceDeletions(sourceDir, pkgDir, new Set(types));
    await syncAuthoritativeRetrieveIntoSource(sourceDir, pkgDir);
    return ok({ deletedCount: reconcile.deletedCount });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  } finally {
    // Best-effort: the manifest + the whole throwaway project tree.
    await rm(manifestPath, { force: true }).catch(() => {});
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
};

const runSfRetrieve = async (
  targetOrg: string,
  sourceDir: string,
  requestedTypes: ReadonlySet<ComponentType> | null,
): Promise<Result<SfRetrieveResult, string>> => {
  const orgTypes = await getOrgSupportedTypes(targetOrg);
  if (orgTypes === null) {
    process.stderr.write(
      `Warning: could not probe ${targetOrg} metadata types; retrieving the full supported set (may fail on types the org lacks).\n`,
    );
  }
  const { included: manifestTypes, dropped } = selectManifestTypes(requestedTypes, orgTypes);
  if (dropped.length > 0) {
    // Show the Metadata API xmlName each internal type was checked against, so
    // a genuine absence (the org has none) is distinguishable from a mapping
    // miss. `Foo` prints bare; an aliased `Foo` prints `Foo (ApiName)`.
    const labelled = dropped
      .map((type) => (toApiName(type) === type ? type : `${type} (${toApiName(type)})`))
      .join(', ');
    process.stdout.write(
      `Skipping ${dropped.length} metadata type(s) the ${targetOrg} describe does not expose: ${labelled}\n`,
    );
  }
  if (manifestTypes.length === 0) {
    return err(`No retrievable metadata types for ${targetOrg} after intersecting with the org's describe.`);
  }

  const outcome = await retrieveWithFallback(manifestTypes, (types) =>
    retrieveTypeBatch(targetOrg, sourceDir, types),
  );
  // Total failure (every type failed — typically a shared auth/network cause)
  // is still fatal: a vault with zero retrieved types is worse than none.
  if (outcome.succeeded.length === 0) {
    return err(`sf project retrieve failed: ${summarizeRetrieveFailures(outcome.failures)}`);
  }
  // CR-P3-3: a type is CONFIRMED-CLEAN-retrieved only when the org describe
  // was non-null (so we know the org actually supports the type) AND the type
  // landed in `succeeded`. When the describe probe failed (`orgTypes === null`,
  // describe-blind pull), `selectManifestTypes` passed the FULL supported set
  // through unfiltered, so a clean wildcard retrieve of a type the org does not
  // have can land zero members with `ok` and no error — that is NOT a
  // trustworthy confirmed-empty. So `confirmedTypes` is null in the
  // describe-blind case, blocking every type from reading as confirmed-empty.
  // `succeeded ⊆ manifestTypes ⊆ orgTypes` (selectManifestTypes already
  // intersected with the describe), so the succeeded set is exactly the
  // describe-confirmed-and-landed set.
  const confirmedTypes =
    orgTypes === null ? null : new Set<ComponentType>(outcome.succeeded);
  return ok({
    manifestTypes: outcome.succeeded,
    deletedCount: outcome.deletedCount,
    failures: outcome.failures,
    confirmedTypes,
  });
};

/**
 * Types whose source was reconciled this run and had zero extractor failures.
 * Types with any failure are excluded so a parse error cannot delete graph rows.
 */
const computeReconciledTypes = (
  pullManifestTypes: readonly ComponentType[] | null,
  sourceRoot: string,
  failures: readonly RefreshExtractionFailure[],
): ReadonlySet<ComponentType> | null => {
  if (pullManifestTypes === null || pullManifestTypes.length === 0) return null;
  const failureTypes = new Set<ComponentType>();
  for (const failure of failures) {
    const type = componentTypeFromSourcePath(sourceRoot, failure.path, false);
    if (type !== null) failureTypes.add(type);
  }
  const reconciled = pullManifestTypes.filter((type) => !failureTypes.has(type));
  return reconciled.length > 0 ? new Set(reconciled) : null;
};

/**
 * Retrieve a specific list of CustomObjects by name into `sourceDir` — the B29
 * auto-expansion second pass for objects your automation references but the
 * `<members>*</members>` wildcard excluded. Best-effort: the caller treats a
 * failure as non-fatal and keeps the first-pass results.
 */
const runSfRetrieveObjects = async (
  targetOrg: string,
  sourceDir: string,
  objectNames: readonly string[],
): Promise<Result<void, string>> => {
  const manifest = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <types>',
    ...objectNames.map((name) => `    <members>${name}</members>`),
    '    <name>CustomObject</name>',
    '  </types>',
    `  <version>${SF_API_VERSION}</version>`,
    '</Package>',
  ].join('\n');
  const manifestPath = join(tmpdir(), `sfi-refresh-expand-${Date.now()}.xml`);
  await writeFile(manifestPath, manifest, 'utf8');
  try {
    await runSf(
      ['project', 'retrieve', 'start', '--manifest', manifestPath, '--target-org', targetOrg, '--output-dir', sourceDir],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_RETRIEVE_TIMEOUT_MS },
    );
    return ok(undefined);
  } catch (cause) {
    return err(
      `expansion retrieve failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await rm(manifestPath, { force: true }).catch(() => {});
  }
};

/**
 * Opt-in `--with-reports` retrieve of folder-based Report / Dashboard metadata.
 *
 * Reports and Dashboards live in folders, and `<members>*</members>` only pulls
 * the *unfiled* ones — so they are invisible to the default retrieve, and a field
 * used only in a report column / dashboard component reads as unused. This
 * enumerates each report/dashboard's metadata name `FolderDeveloperName/Name` via
 * SOQL (mapping the record's `FolderName` label to the folder's `DeveloperName`)
 * and requests them explicitly. Best-effort: a SOQL or retrieve failure is
 * non-fatal and leaves the rest of the refresh intact; unfiled / personal items
 * with no matching `Folder` row are skipped. The retrieved field usage is folded
 * onto the fields downstream (`foldReportDashboardUsageIntoFields`) — no per-report
 * node is persisted. Returns the count requested per type.
 */
/** SOQL record rows feeding the foldered-report manifest builder. */
export interface FolderedReportQueryRows {
  /** `SELECT Name, DeveloperName FROM Folder WHERE Type IN ('Report','Dashboard')`. */
  readonly folders: readonly Record<string, unknown>[];
  /** `SELECT DeveloperName, FolderName FROM Report`. */
  readonly reports: readonly Record<string, unknown>[];
  /** `SELECT DeveloperName, FolderName FROM Dashboard`. */
  readonly dashboards: readonly Record<string, unknown>[];
}

/** Result of folding the SOQL rows into a retrievable manifest. */
export interface FolderedReportManifest {
  readonly membersByType: Readonly<Record<'Report' | 'Dashboard', readonly string[]>>;
  readonly reports: number;
  readonly dashboards: number;
  /** package.xml to retrieve, or `null` when no foldered member resolved. */
  readonly manifestXml: string | null;
}

/**
 * Pure transform: SOQL Folder/Report/Dashboard rows → explicit `Folder/Name`
 * members + a `package.xml`. Reports and Dashboards are folder-based, and the
 * `<members>*</members>` wildcard only pulls UNFILED ones, so each filed
 * report/dashboard needs an explicit `FolderDeveloperName/DeveloperName` member.
 * A record whose `FolderName` label maps to no retrievable folder (unfiled /
 * personal) is skipped. Extracted from the side-effecting retrieve so the
 * member-format + manifest assembly are unit-testable without an org.
 */
export const buildFolderedReportManifest = (
  rows: FolderedReportQueryRows,
): FolderedReportManifest => {
  // 1. Folder label -> DeveloperName (the metadata folder name).
  const folderDevName = new Map<string, string>();
  for (const r of rows.folders) {
    const name = typeof r['Name'] === 'string' ? r['Name'] : null;
    const dev = typeof r['DeveloperName'] === 'string' ? r['DeveloperName'] : null;
    if (name !== null && dev !== null) folderDevName.set(name, dev);
  }

  // 2. Build explicit `Folder/Name` members per type.
  const membersByType: Record<'Report' | 'Dashboard', string[]> = {
    Report: [],
    Dashboard: [],
  };
  const recordsByType: Record<'Report' | 'Dashboard', readonly Record<string, unknown>[]> = {
    Report: rows.reports,
    Dashboard: rows.dashboards,
  };
  for (const type of ['Report', 'Dashboard'] as const) {
    for (const r of recordsByType[type]) {
      const dev = typeof r['DeveloperName'] === 'string' ? r['DeveloperName'] : null;
      const folderLabel = typeof r['FolderName'] === 'string' ? r['FolderName'] : null;
      if (dev === null || folderLabel === null) continue;
      const folderDev = folderDevName.get(folderLabel);
      if (folderDev === undefined) continue; // unfiled / personal — no retrievable folder
      membersByType[type].push(`${folderDev}/${dev}`);
    }
  }

  const reports = membersByType.Report.length;
  const dashboards = membersByType.Dashboard.length;
  if (reports === 0 && dashboards === 0) {
    return { membersByType, reports: 0, dashboards: 0, manifestXml: null };
  }

  // 3. package.xml — one <types> block per non-empty type.
  const typesXml = (['Report', 'Dashboard'] as const)
    .filter((t) => membersByType[t].length > 0)
    .map(
      (t) =>
        `  <types>\n${membersByType[t]
          .map((m) => `    <members>${m}</members>`)
          .join('\n')}\n    <name>${t}</name>\n  </types>`,
    )
    .join('\n');
  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n  <version>${SF_API_VERSION}</version>\n</Package>\n`;
  return { membersByType, reports, dashboards, manifestXml };
};

/** Per-type requested-vs-landed fidelity of a foldered report/dashboard retrieve. */
export interface ReportRetrieveFidelity {
  readonly requested: number;
  readonly landed: number;
  /** Requested `Folder/Name` members with no matching file on disk after the pull. */
  readonly missing: readonly string[];
}

const REPORT_META_SUFFIXES = {
  Report: '.report-meta.xml',
  Dashboard: '.dashboard-meta.xml',
} as const;
const REPORT_DIR_MARKERS = { Report: 'reports', Dashboard: 'dashboards' } as const;

/**
 * P14-USAGE-reports-retrieve-fidelity: a foldered Report/Dashboard retrieve
 * can land FEWER files than the manifest requested — members deleted between
 * the ranking query and the pull, folder renames, or members the Metadata API
 * drops without raising an error (a live run delivered 78 of 83 requested
 * dashboards). Counting raw files on disk would over-count (files from
 * earlier pulls linger in `source/`), so fidelity is a MEMBERSHIP check:
 * which requested `Folder/Name` members have a matching meta file under the
 * source tree. The member key is the file path relative to the last
 * `reports`/`dashboards` path segment (nested Lightning folders keep their
 * `Parent/Child/Name` shape). Pure — callers walk the tree and pass paths.
 */
export const countLandedReportMembers = (
  membersByType: Readonly<Record<'Report' | 'Dashboard', readonly string[]>>,
  landedFiles: readonly string[],
): Readonly<Record<'Report' | 'Dashboard', ReportRetrieveFidelity>> => {
  const landedByType: Record<'Report' | 'Dashboard', Set<string>> = {
    Report: new Set(),
    Dashboard: new Set(),
  };
  for (const file of landedFiles) {
    const segments = file.split(/[\\/]+/);
    const name = segments[segments.length - 1] ?? '';
    for (const type of ['Report', 'Dashboard'] as const) {
      const suffix = REPORT_META_SUFFIXES[type];
      if (!name.endsWith(suffix)) continue;
      const marker = segments.lastIndexOf(REPORT_DIR_MARKERS[type]);
      const tail = marker >= 0 ? segments.slice(marker + 1) : segments.slice(-2);
      landedByType[type].add(tail.join('/').slice(0, -suffix.length));
    }
  }
  const fidelity = (type: 'Report' | 'Dashboard'): ReportRetrieveFidelity => {
    const requested = membersByType[type];
    const missing = requested.filter((m) => !landedByType[type].has(m));
    return { requested: requested.length, landed: requested.length - missing.length, missing };
  };
  return { Report: fidelity('Report'), Dashboard: fidelity('Dashboard') };
};

/** Recursively collect `*.report-meta.xml` / `*.dashboard-meta.xml` paths (best-effort). */
const collectReportMetaFiles = async (dir: string): Promise<readonly string[]> => {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectReportMetaFiles(full)));
    } else if (
      entry.name.endsWith(REPORT_META_SUFFIXES.Report) ||
      entry.name.endsWith(REPORT_META_SUFFIXES.Dashboard)
    ) {
      out.push(full);
    }
  }
  return out;
};

const runSfRetrieveFolderedReports = async (
  targetOrg: string,
  sourceDir: string,
): Promise<Result<{ readonly reports: number; readonly dashboards: number }, string>> => {
  const soql = async (
    query: string,
  ): Promise<readonly Record<string, unknown>[]> => {
    const { stdout } = await runSf(
      ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_QUERY_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as {
      result?: { records?: readonly Record<string, unknown>[] };
    };
    return parsed.result?.records ?? [];
  };

  // Query the three sources. Folder enumeration is required; a missing
  // Report/Dashboard object is non-fatal (best-effort per type).
  let folders: readonly Record<string, unknown>[];
  try {
    folders = await soql(
      "SELECT Name, DeveloperName FROM Folder WHERE Type IN ('Report','Dashboard') AND DeveloperName != null",
    );
  } catch (cause) {
    return err(
      `folder enumeration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const queryRecords = async (
    type: 'Report' | 'Dashboard',
  ): Promise<readonly Record<string, unknown>[]> => {
    try {
      return await soql(
        `SELECT DeveloperName, FolderName FROM ${type} WHERE DeveloperName != null`,
      );
    } catch {
      return [];
    }
  };

  const { reports, dashboards, manifestXml } = buildFolderedReportManifest({
    folders,
    reports: await queryRecords('Report'),
    dashboards: await queryRecords('Dashboard'),
  });
  if (manifestXml === null) return ok({ reports: 0, dashboards: 0 });

  // Manifest + retrieve.
  const manifest = manifestXml;
  const manifestPath = join(tmpdir(), `sfi-refresh-reports-${Date.now()}.xml`);
  await writeFile(manifestPath, manifest, 'utf8');
  try {
    await runSf(
      ['project', 'retrieve', 'start', '--manifest', manifestPath, '--target-org', targetOrg, '--output-dir', sourceDir],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_RETRIEVE_TIMEOUT_MS },
    );
    return ok({ reports, dashboards });
  } catch (cause) {
    return err(
      `report/dashboard retrieve failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await rm(manifestPath, { force: true }).catch(() => {});
  }
};

/** Cap for the default usage-ranked report/dashboard pull (P13-REPORTS-default). */
const reportsCap = (): number => {
  const raw = Number(process.env['SFI_REPORTS_CAP']);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 500;
};

/**
 * P13-REPORTS-default (user decision 2026-06-10): the DEFAULT refresh pulls
 * the TOP-N foldered Reports/Dashboards ranked by actual USAGE — Reports by
 * `LastRunDate`, Dashboards by `LastViewedDate`, both falling back to
 * `LastModifiedDate` — via read-only SOQL, then retrieves exactly those
 * members. Their field references are folded onto fields (no nodes), and
 * when an org holds more than the cap the coverage rows go `pending` so
 * absence claims about report usage stay qualified. `--with-reports` is the
 * uncapped full pull; `--no-reports` skips entirely.
 */
export const runSfRetrieveSmartReports = async (
  targetOrg: string,
  sourceDir: string,
  cap: number,
): Promise<
  Result<
    {
      readonly reports: number;
      readonly dashboards: number;
      readonly totals: { readonly reports: number; readonly dashboards: number };
      /** Requested members whose meta file actually LANDED on disk (P14-USAGE-reports-retrieve-fidelity). */
      readonly landed: { readonly reports: number; readonly dashboards: number };
      /** `Type:Folder/Name` members requested but not delivered by the retrieve. */
      readonly missing: readonly string[];
    },
    string
  >
> => {
  const soql = async (query: string): Promise<readonly Record<string, unknown>[]> => {
    const { stdout } = await runSf(
      ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_QUERY_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as {
      result?: { records?: readonly Record<string, unknown>[]; totalSize?: number };
    };
    return parsed.result?.records ?? [];
  };
  const count = async (query: string): Promise<number> => {
    try {
      const { stdout } = await runSf(
        ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
        { maxBuffer: SF_MAX_BUFFER, timeout: SF_QUERY_TIMEOUT_MS },
      );
      const parsed = JSON.parse(stdout) as { result?: { totalSize?: number } };
      return parsed.result?.totalSize ?? 0;
    } catch {
      return 0;
    }
  };

  let folders: readonly Record<string, unknown>[];
  try {
    folders = await soql(
      "SELECT Name, DeveloperName FROM Folder WHERE Type IN ('Report','Dashboard') AND DeveloperName != null",
    );
  } catch (cause) {
    return err(
      `folder enumeration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const ranked = async (
    type: 'Report' | 'Dashboard',
    usageField: string,
  ): Promise<readonly Record<string, unknown>[]> => {
    try {
      return await soql(
        `SELECT DeveloperName, FolderName FROM ${type} WHERE DeveloperName != null ORDER BY ${usageField} DESC NULLS LAST, LastModifiedDate DESC LIMIT ${cap}`,
      );
    } catch {
      // usage field unsupported on this org edition — fall back to modified
      try {
        return await soql(
          `SELECT DeveloperName, FolderName FROM ${type} WHERE DeveloperName != null ORDER BY LastModifiedDate DESC LIMIT ${cap}`,
        );
      } catch {
        return [];
      }
    }
  };
  const totals = {
    reports: await count('SELECT COUNT() FROM Report'),
    dashboards: await count('SELECT COUNT() FROM Dashboard'),
  };
  const { reports, dashboards, manifestXml, membersByType } = buildFolderedReportManifest({
    folders,
    reports: await ranked('Report', 'LastRunDate'),
    dashboards: await ranked('Dashboard', 'LastViewedDate'),
  });
  if (manifestXml === null) {
    return ok({ reports: 0, dashboards: 0, totals, landed: { reports: 0, dashboards: 0 }, missing: [] });
  }

  const manifestPath = join(tmpdir(), `sfi-refresh-smart-reports-${Date.now()}.xml`);
  await writeFile(manifestPath, manifestXml, 'utf8');
  try {
    await runSf(
      ['project', 'retrieve', 'start', '--manifest', manifestPath, '--target-org', targetOrg, '--output-dir', sourceDir],
      { maxBuffer: SF_MAX_BUFFER, timeout: SF_RETRIEVE_TIMEOUT_MS },
    );
    // Requested-vs-landed: membership check against the freshly-pulled tree
    // (raw file counts would be inflated by files from earlier pulls).
    const fidelity = countLandedReportMembers(membersByType, await collectReportMetaFiles(sourceDir));
    return ok({
      reports,
      dashboards,
      totals,
      landed: { reports: fidelity.Report.landed, dashboards: fidelity.Dashboard.landed },
      missing: [
        ...fidelity.Report.missing.map((m) => `Report:${m}`),
        ...fidelity.Dashboard.missing.map((m) => `Dashboard:${m}`),
      ],
    });
  } catch (cause) {
    return err(
      `smart report retrieve failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await rm(manifestPath, { force: true }).catch(() => {});
  }
};

/** Format one extractor failure for the CLI summary line. */
const formatFailure = (failure: RefreshExtractionFailure): string =>
  `  ${failure.path}: ${failure.error.kind} — ${failure.error.message}`;

/** Format a counts block (Components or Edges) for the summary. */
const formatBlock = (label: string, counts: Readonly<Record<string, number | undefined>>): readonly string[] => {
  const entries = Object.entries(counts).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return [label, '  (none)'];
  return [label, ...entries.map(([k, v]) => `  ${k}: ${v ?? 0}`)];
};

/**
 * Format the "Changes since last refresh" block — the plain-language answer to
 * "what's new?" after a refresh. Handles first-refresh, no-op (identical source
 * tree), in-place-edit (hash changed, counts unchanged), and count-delta cases.
 */
const formatChangeSummary = (cs: ChangeSummary): readonly string[] => {
  if (cs.previousRefreshedAt === null) {
    return ['Changes since last refresh', '  First refresh — no prior snapshot to compare.'];
  }
  const header = `Changes since last refresh (since ${cs.previousRefreshedAt})`;
  if (!cs.sourceTreeHashChanged) {
    return [header, '  No metadata changes — source tree identical to the last refresh.'];
  }
  const fmt = (deltas: Readonly<Record<string, number>>): string[] =>
    Object.entries(deltas)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `    ${v > 0 ? '+' : ''}${v} ${k}`);
  const compLines = fmt(cs.componentDeltas);
  const edgeLines = fmt(cs.edgeDeltas);
  const out: string[] = [header];
  const gm = cs.graphMetrics;
  const sign = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
  out.push(
    `  Graph: ${gm.components.current} components (${sign(gm.components.delta)}), ${gm.edges.current} edges (${sign(gm.edges.delta)})`,
  );
  if (compLines.length === 0 && edgeLines.length === 0) {
    out.push('  Source tree changed but counts are unchanged (in-place edits to existing components).');
  } else {
    if (compLines.length > 0) out.push('  Components:', ...compLines);
    if (edgeLines.length > 0) out.push('  Edges:', ...edgeLines);
  }
  out.push('  Component-level detail: run `sfi snapshot create`, then ask sfi.diff_snapshots / sfi.changed_since.');
  return out;
};

/** Pretty-print a `RefreshResult` to a multi-line string for the CLI handler. @example process.stdout.write(formatRefreshSummary(result)); */
export const formatRefreshSummary = (result: RefreshResult): string => {
  const lines: string[] = [
    `Refresh ${result.status} in ${result.durationMs} ms`,
    '',
    ...formatBlock('Components', result.counts.components),
    '',
    ...formatBlock('Edges', result.counts.edges),
  ];
  if (result.changeSummary !== undefined) {
    lines.push('', ...formatChangeSummary(result.changeSummary));
  }
  if (result.pulse !== undefined) {
    lines.push('', 'Pulse', ...result.pulse.highlights.map((h) => `  ${h}`));
  }
  if (result.errors.length > 0) {
    lines.push('', `Errors (${result.errors.length}):`, ...result.errors.map(formatFailure));
  }
  if (result.retrieveFailures !== undefined && result.retrieveFailures.length > 0) {
    lines.push(
      '',
      `Partial retrieve — ${result.retrieveFailures.length} metadata type(s) skipped (the org may have rejected them; the vault is built from what landed):`,
      ...result.retrieveFailures.map((f) => `  ${f.type}: ${salientErrorLine(f.error)}`),
    );
  }
  if (result.fatalError !== undefined) {
    lines.push('', `Fatal: ${result.fatalError}`);
  }
  if (result.toolingApi !== undefined) {
    lines.push('', formatToolingApiSummary(result.toolingApi));
  }
  if (result.reportsCap !== undefined) {
    lines.push('', ...formatReportsCapSummary(result.reportsCap));
  }
  const skippedWarning = formatSkippedWarning(result.skippedDirectories);
  if (skippedWarning !== null) {
    lines.push('', ...skippedWarning);
  }
  lines.push('');
  return lines.join('\n');
};

/**
 * P14-USAGE-reports-retrieve-fidelity: the requested-vs-landed block of the
 * usage-ranked report/dashboard pull. Three honest numbers per type: org
 * total, manifest members requested, files that landed. A requested member
 * the retrieve silently dropped is called out — it was NOT checked, so
 * absence claims about it must stay qualified (its coverage row is pending).
 */
export const formatReportsCapSummary = (
  rc: NonNullable<RefreshResult['reportsCap']>,
): readonly string[] => {
  const row = (
    label: string,
    c: { readonly total: number; readonly requested: number; readonly retrieved: number },
  ): string => {
    const dropped = c.requested - c.retrieved;
    const beyondCap = c.total - c.requested;
    const notes = [
      ...(dropped > 0 ? [`${dropped} requested member(s) did not land — not checked`] : []),
      ...(beyondCap > 0 ? [`${beyondCap} beyond the usage cap stay pending`] : []),
    ];
    return `  ${label}: ${c.retrieved}/${c.requested} requested landed (org total ${c.total})${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}`;
  };
  return [
    'Reports / Dashboards (usage-ranked pull)',
    row('Reports', rc.reports),
    row('Dashboards', rc.dashboards),
  ];
};

/** Number of top entries to surface in the warning block. */
const SKIPPED_TOP_N = 5;

/** Retrieved metadata families with no extractor yet — not "unknown" surprises. */
const KNOWN_UNMODELED_SKIP_DIRS: Readonly<Record<string, string>> = {
  sharingReasons: 'SharingReason (not modeled — skipped files are not org absence)',
};

/**
 * Render the skipped-directories warning block, or `null` if the map is
 * empty.
 *
 * The warning surfaces the architectural-bug fix: previously the walker
 * silently dropped every unknown directory entry, so a vault could
 * report `kind: "fresh"` while invisibly missing thousands of files
 * from metadata types the build doesn't yet cover. Operators now see
 * a structured, sortable, total-and-top-N block at the end of the
 * refresh summary, with a pointer to `sfi status --skipped` for the
 * full inventory.
 */
const formatSkippedWarning = (
  skipped: Readonly<Record<string, number>>,
): readonly string[] | null => {
  const entries = Object.entries(skipped);
  if (entries.length === 0) return null;
  const totalFiles = entries.reduce((sum, [, n]) => sum + n, 0);
  const sorted = [...entries].sort(([aKey, aCount], [bKey, bCount]) =>
    bCount !== aCount ? bCount - aCount : aKey < bKey ? -1 : aKey > bKey ? 1 : 0,
  );
  const lines: string[] = [
    `WARNING: ${totalFiles} files in ${entries.length} unknown ${entries.length === 1 ? 'directory was' : 'directories were'} skipped during extraction.`,
    `This usually means the retrieve included metadata types this build doesn't yet cover.`,
    `Top skipped directories:`,
    ...sorted
      .slice(0, SKIPPED_TOP_N)
      .map(([name, count]) => {
        const note = KNOWN_UNMODELED_SKIP_DIRS[name];
        const label = note !== undefined ? `${name} — ${note}` : name;
        return `  - ${label} (${count} ${count === 1 ? 'file' : 'files'})`;
      }),
    `Run \`sfi status --skipped\` for the full list.`,
  ];
  return lines;
};

/**
 * Format the v1.7 R2 Tooling API summary as a single one-line block.
 * Surfaced beneath the offline pipeline's component/edge counts so the
 * live-data axis stays visually separate from the offline output.
 */
const formatToolingApiSummary = (summary: ToolingApiRefreshSummary): string => {
  if (summary.fatalMessage !== undefined) {
    return `Tooling API: ${summary.outcome} — ${summary.fatalMessage}`;
  }
  return `Tooling API: enriched ${summary.enrichedCount} components, ${summary.errorCount} errors`;
};

/**
 * Commander flag shape. `pull` is the negated form of `--no-pull`:
 * commander sets `pull = false` when `--no-pull` is passed, `true` (the
 * default) otherwise.
 */
interface RefreshCliFlags {
  readonly targetOrg?: string;
  readonly pull?: boolean;
  readonly types?: string;
  readonly withToolingApi?: boolean;
  /** P13-FACTS-capture: opt-in record-data capture into the facts table. */
  readonly withDataShape?: boolean;
  readonly incremental?: boolean;
  /** P7-incremental-graph-update: transactional change-set graph apply. */
  readonly incrementalGraph?: boolean;
  /** P7-demand-retrieve: comma-separated component ids for a targeted pull. */
  readonly components?: string;
  /** Opt-in `--with-reports`: also pull folder-based Report / Dashboard metadata. */
  readonly withReports?: boolean;
  /** `--no-reports` sets this false (commander negation of `reports`). */
  readonly reports?: boolean;
  /** P13-STAGED-tiers: build the vault in tiers (skeleton → priority → full). */
  readonly staged?: boolean;
  /** P13-STAGED-demand-queue: drain queued automation-critical phantom hits. */
  readonly drainDemandQueue?: boolean;
  /** P13-AST-edges: opt-in parser-grade Apex edge pass. */
  readonly apexAst?: boolean;
}

/**
 * Register the `sfi refresh` subcommand on `program`. Exits 0 on success,
 * 1 on partial or failed. Thin shim around `runRefresh`.
 *
 * The optional `--with-tooling-api` flag (PLAN-v1.7 R2) triggers the
 * live freshness enrichment pass after the offline pipeline completes;
 * default refresh is fully offline.
 *
 * @example
 *   registerRefreshCommand(new Command());
 */
// ===========================================================================
// P7-demand-retrieve — `sfi refresh --components <ids>`
// ===========================================================================

/** Outcome of a demand-retrieve run. */
export interface DemandRetrieveResult {
  readonly status: 'success' | 'failed';
  /** Ids retrieved (automation-critical) — now L3 nodes after re-extract. */
  readonly retrieved: readonly ComponentId[];
  /** Ids refused by the gate, each with its classification + reason. */
  readonly refused: readonly {
    readonly id: string;
    readonly classification: PhantomClassification;
    readonly reason: string;
  }[];
  /** Ids that were already real nodes in the vault (nothing to do). */
  readonly alreadyPresent: readonly string[];
  readonly message?: string;
}

const demandCoverageStatusOf = (
  manifest: ExtendedVaultManifest,
  type: string,
): CoverageStatus => {
  const e = manifestCoverageEntries(manifest).find((c) => c.type === type);
  if (e === undefined) return 'absent';
  if (e.neverModeled) return 'notModeled';
  if (e.requested && e.retrieved > 0 && !e.errored) return 'covered';
  return 'partial';
};

const DEMAND_REFUSAL_REASON: Record<PhantomClassification, string> = {
  'automation-critical': 'automation-critical',
  'blindspot-manifest':
    'its ComponentType was never retrieved — widen the manifest with a plain `sfi refresh`, not a targeted pull',
  'managed-extension': 'a managed-package member — its source is not retrievable',
  'standard-field-phantom':
    'a standard object/field — referenced, not retrieved into the custom vault',
  'grant-only':
    'only permission grants reference it — not worth retrieving (the 700+ grant-only trap)',
  unknown:
    'not an automation-critical reference — nothing depends on it that demand-retrieve would fix',
};

/**
 * Classify the requested ids against the current vault, partitioning them into
 * the automation-critical CustomObjects to pull, the refused (with reason), and
 * the already-present. Exported so the gate can be unit-tested without a live org.
 */
export const classifyForDemandRetrieve = async (
  store: GraphStore,
  manifest: ExtendedVaultManifest,
  ids: readonly string[],
): Promise<{
  readonly retrieveObjects: readonly string[];
  readonly refused: DemandRetrieveResult['refused'];
  readonly alreadyPresent: readonly string[];
}> => {
  const retrieveObjects: string[] = [];
  const refused: {
    id: string;
    classification: PhantomClassification;
    reason: string;
  }[] = [];
  const alreadyPresent: string[] = [];
  for (const id of ids) {
    const existing = await getNodeById(store, id as ComponentId);
    if (existing.ok && existing.value !== null) {
      alreadyPresent.push(id);
      continue;
    }
    const inbound = await listEdges(store, id as ComponentId, { direction: 'in' });
    const edges = inbound.ok ? inbound.value : [];
    if (edges.length === 0) {
      refused.push({
        id,
        classification: 'unknown',
        reason: 'not referenced by anything in this vault — unknown id',
      });
      continue;
    }
    const edgeKinds = [...new Set(edges.map((e) => e.edgeType))];
    const nonHeuristic = [
      ...new Set(edges.filter((e) => e.confidence !== 'heuristic').map((e) => e.edgeType)),
    ];
    const type = id.slice(0, Math.max(0, id.indexOf(':')));
    const classification = classifyPhantom(
      id as ComponentId,
      edgeKinds,
      nonHeuristic,
      demandCoverageStatusOf(manifest, type),
    );
    if (classification === 'automation-critical' && id.startsWith('CustomObject:')) {
      retrieveObjects.push(id.slice('CustomObject:'.length));
    } else if (classification === 'automation-critical') {
      refused.push({
        id,
        classification,
        reason:
          'automation-critical but not a CustomObject — demand-retrieve currently pulls CustomObject only',
      });
    } else {
      refused.push({ id, classification, reason: DEMAND_REFUSAL_REASON[classification] });
    }
  }
  return { retrieveObjects, refused, alreadyPresent };
};

/**
 * `sfi refresh --components <ids>` — demand-retrieve. Classifies each requested
 * id against the current vault and pulls ONLY the automation-critical CustomObject
 * phantoms from the live org (generalizing the B29 auto-expansion to a
 * user-triggered pull), then re-extracts so they become L3 nodes. Grant-only /
 * managed / standard / blindspot ids are refused with their reason — a targeted
 * pull never bloats the vault with the 700+ grant-only trap. The B29 batch path
 * (a plain `sfi refresh`) is unchanged.
 */
/**
 * P13-STAGED-demand-queue: record each processed id's drain outcome in the
 * vault's demand queue. Append-only and best-effort — outcomes for ids the
 * queue never saw are ignored at read time, so unconditional marking is
 * safe and a re-drain of an already-drained id is a no-op (idempotent).
 */
export const markDemandQueueDrains = async (
  vaultRoot: string,
  outcome: Pick<DemandRetrieveResult, 'retrieved' | 'refused' | 'alreadyPresent'>,
): Promise<void> => {
  for (const id of outcome.retrieved) {
    await appendDrainResult(vaultRoot, id, 'retrieved');
  }
  for (const id of outcome.alreadyPresent) {
    await appendDrainResult(vaultRoot, id, 'already-present');
  }
  for (const ref of outcome.refused) {
    await appendDrainResult(vaultRoot, ref.id, 'refused', ref.reason);
  }
};

export const runDemandRetrieve = async (opts: {
  readonly cwd: string;
  readonly components: readonly string[];
  readonly targetOrg?: string;
  readonly onProgress?: (message: string) => void;
}): Promise<DemandRetrieveResult> => {
  const progress = opts.onProgress ?? (() => {});
  const empty = { retrieved: [], refused: [], alreadyPresent: [] } as const;
  const configResult = await loadVaultConfig(opts.cwd);
  if (!configResult.ok) return { status: 'failed', ...empty, message: configResult.error };
  const paths = vaultPaths(configResult.value.vaultRoot);
  const targetOrg = opts.targetOrg ?? configResult.value.targetOrg;
  // Defense in depth (CR-01 / C1): validate the `--target-org` flag override,
  // which bypasses the config.json check in loadVaultConfig.
  if (opts.targetOrg !== undefined) {
    const aliasCheck = validateOrgAlias(opts.targetOrg);
    if (!aliasCheck.ok) return { status: 'failed', ...empty, message: aliasCheck.error };
  }

  const manifestResult = await loadManifest(paths.root);
  if (!manifestResult.ok) {
    return { status: 'failed', ...empty, message: `loadManifest: ${manifestResult.error.message}` };
  }
  // Classify read-only so a serving MCP server is not disturbed (P5/P7).
  const storeResult = await openGraphReadOnly(paths.graphDb);
  if (!storeResult.ok) {
    return { status: 'failed', ...empty, message: `openGraph: ${storeResult.error.message}` };
  }
  let plan: Awaited<ReturnType<typeof classifyForDemandRetrieve>>;
  try {
    plan = await classifyForDemandRetrieve(
      storeResult.value,
      manifestResult.value,
      opts.components,
    );
  } finally {
    await closeGraph(storeResult.value);
  }

  if (plan.retrieveObjects.length === 0) {
    const result: DemandRetrieveResult = {
      status: 'success',
      retrieved: [],
      refused: plan.refused,
      alreadyPresent: plan.alreadyPresent,
      message: 'No automation-critical component to retrieve.',
    };
    await markDemandQueueDrains(paths.root, result);
    return result;
  }

  progress(
    `Demand-retrieving ${plan.retrieveObjects.length} automation-critical object(s) from ${targetOrg}...`,
  );
  const pulled = await runSfRetrieveObjects(targetOrg, paths.source, plan.retrieveObjects);
  if (!pulled.ok) {
    return {
      status: 'failed',
      retrieved: [],
      refused: plan.refused,
      alreadyPresent: plan.alreadyPresent,
      message: `retrieve failed: ${pulled.error}`,
    };
  }
  // Re-extract + rebuild the graph; the retrieved objects become L3 nodes.
  const refresh = await runRefresh({
    cwd: opts.cwd,
    noPull: true,
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
  });
  const retrieved = plan.retrieveObjects.map((o) => `CustomObject:${o}` as ComponentId);
  const result: DemandRetrieveResult = {
    status: refresh.status === 'success' ? 'success' : 'failed',
    retrieved,
    refused: plan.refused,
    alreadyPresent: plan.alreadyPresent,
    ...(refresh.status !== 'success'
      ? { message: `re-extract failed: ${refresh.fatalError ?? refresh.status}` }
      : {}),
  };
  // Mark drains only on success: a failed re-extract leaves the ids queued,
  // and the next drain re-pulls them (the retrieve itself is idempotent).
  if (result.status === 'success') {
    await markDemandQueueDrains(paths.root, result);
  }
  return result;
};

/** Human summary for `sfi refresh --components`. */
export const formatDemandRetrieveSummary = (r: DemandRetrieveResult): string => {
  const lines: string[] = [
    r.status === 'success'
      ? 'Demand-retrieve complete.'
      : `Demand-retrieve FAILED: ${r.message ?? ''}`,
  ];
  if (r.retrieved.length > 0) lines.push(`  retrieved (now L3): ${r.retrieved.join(', ')}`);
  if (r.alreadyPresent.length > 0) lines.push(`  already present: ${r.alreadyPresent.join(', ')}`);
  for (const ref of r.refused) {
    lines.push(`  refused ${ref.id} [${ref.classification}]: ${ref.reason}`);
  }
  return `${lines.join('\n')}\n`;
};

export const registerRefreshCommand = (program: Command): void => {
  program
    .command('refresh')
    .description('Refresh the vault from a live Salesforce org')
    .option('--target-org <alias>', 'Salesforce org alias to retrieve from (overrides config.json)')
    .option('--no-pull', 'Skip `sf project retrieve` and use the existing source tree')
    .option('--types <list>', 'Comma-separated metadata types to restrict the refresh to')
    .option(
      '--with-data-shape',
      'After the refresh, capture a small budgeted set of record-DATA observations (approximate per-object record counts + recent-sample field fill rates) into the graph facts table. OPT-IN twice over: requires live consent for the org (sfi.live_consent / SFI_LIVE_PLANE_ENABLED) — without it the capture skips honestly and the refresh stays offline. Read-only; at most SFI_DATA_SHAPE_BUDGET (default 60) API calls.',
    )
    .option(
      '--with-tooling-api',
      'After the offline refresh completes, run the v1.7 R2 Tooling API enrichment pass to hydrate `lastModifiedDate` / `lastModifiedBy` / `apiVersion` on enrichable nodes. Requires `sf` CLI installed and the target org alias authenticated.',
    )
    .option(
      '--incremental',
      'Reuse the previous refresh\'s per-file extraction cache (`meta/extract-cache.json`): source files whose mtime + size are unchanged skip re-extraction. The graph is still rebuilt in full, so results are identical to a cold refresh — only faster. The cache is invalidated automatically on a version upgrade.',
    )
    .option(
      '--incremental-graph',
      'Re-import ONLY the changed nodes/edges into the graph (a transactional change-set diff against the current graph) instead of rebuilding it in full, when a prior non-empty graph exists. Provably byte-identical to a cold rebuild; falls back to a full rebuild on an empty/largely-changed graph or any apply error. Independent of `--incremental` (the parse cache); combine both for the largest win. Off by default.',
    )
    .option(
      '--components <list>',
      'Demand-retrieve: comma-separated component ids (e.g. `CustomObject:Foo__c`) to pull on demand. Only AUTOMATION-CRITICAL phantoms are retrieved; grant-only / managed / standard / blindspot ids are refused with the reason. Generalizes the automatic B29 expansion to a user-triggered pull.',
    )
    .option(
      '--no-reports',
      'Skip the report/dashboard pull entirely. DEFAULT (neither flag): pull the top SFI_REPORTS_CAP (500) reports+dashboards ranked by actual usage (LastRunDate / LastViewedDate, fallback LastModifiedDate) and fold their field references onto fields; when the org holds more than the cap, Report/Dashboard coverage reads `pending` so absence claims stay qualified.',
    )
    .option(
      '--with-reports',
      'Also pull folder-based Report / Dashboard metadata and fold their field usage onto the referenced fields, so a field used only in a report column / dashboard component stops reading as unused. Off by default — slow on large orgs (enumerates folders + pulls every report/dashboard).',
    )
    .option(
      '--staged',
      'Build the vault in tiers for fast time-to-first-insight: T0 skeleton (read-only COUNT queries, no retrieve) → T1 priority types (objects/fields/automation/Apex/permissions; Markdown render deferred) → T2 full refresh (transactional side-build — a mid-tier failure leaves the prior state servable) → optional T3 with --with-reports. Mid-build, health_check reports degraded (building tier i/n) and queued types read as pending coverage, so absence claims stay qualified. Resumable: a re-run skips completed tiers. The final tier is a plain monolithic refresh, so the end state is identical to a non-staged run.',
    )
    .option(
      '--no-apex-ast',
      "Skip the parser-grade Apex pass (ON by default): every class/trigger is re-parsed with the vendored ANTLR grammar adding `confidence: 'parsed'`, `source: 'apex-ast'` readsFrom/writesTo/callsApex edges — including SOQL field-level reads and constant-string Database.query literals. Exact-duplicate heuristic scanner edges are dropped (no double-counting); scanner-only edges are kept. A file that fails to parse falls back to scanner-only (counted in the manifest's apexAst block).",
    )
    .option(
      '--drain-demand-queue',
      'Drain the phantom demand queue (`meta/demand-queue.jsonl`): retrieve every QUEUED automation-critical component that MCP consumers hit as phantoms (recorded by sfi.get_component), through the same gate as --components — grant-only / managed / standard / blindspot ids are refused with the reason. Dedup and idempotency are structural: N hits on one id drain once, and a re-drain of an already-drained id is a no-op. Drained entries are marked in the queue with their outcome.',
    )
    .action(async (flags: RefreshCliFlags): Promise<void> => {
      // P13-STAGED-demand-queue: drain queued phantom hits via the
      // demand-retrieve gate.
      if (flags.drainDemandQueue === true) {
        const configResult = await loadVaultConfig(process.cwd());
        if (!configResult.ok) {
          process.stderr.write(`${configResult.error}\n`);
          process.exit(1);
        }
        const queue = await readDemandQueue(configResult.value.vaultRoot);
        const ids = queuedDrainIds(queue);
        if (ids.length === 0) {
          process.stdout.write('Demand queue: empty — nothing to drain.\n');
          return;
        }
        process.stderr.write(
          `Demand queue: draining ${ids.length} queued automation-critical id(s)...\n`,
        );
        const dr = await runDemandRetrieve({
          cwd: process.cwd(),
          components: ids,
          ...(flags.targetOrg !== undefined ? { targetOrg: flags.targetOrg } : {}),
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        process.stdout.write(formatDemandRetrieveSummary(dr));
        if (dr.status !== 'success') process.exit(1);
        return;
      }
      // P13-STAGED-tiers: the tiered build path. Lazy import — the staged
      // driver imports runRefresh from this module, so a static import here
      // would create a cycle.
      if (flags.staged === true) {
        const { runStagedRefresh } = await import('./staged-refresh.js');
        const staged = await runStagedRefresh({
          cwd: process.cwd(),
          noPull: flags.pull === false,
          ...(flags.targetOrg !== undefined ? { targetOrg: flags.targetOrg } : {}),
          ...(flags.withReports === true ? { withReports: true } : {}),
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        process.stdout.write(formatRefreshSummary(staged.result));
        if (staged.result.status !== 'success') process.exit(1);
        return;
      }
      // P7-demand-retrieve: a targeted pull, not a full refresh.
      if (flags.components !== undefined) {
        const dr = await runDemandRetrieve({
          cwd: process.cwd(),
          components: flags.components
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          ...(flags.targetOrg !== undefined ? { targetOrg: flags.targetOrg } : {}),
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        process.stdout.write(formatDemandRetrieveSummary(dr));
        if (dr.status !== 'success') process.exit(1);
        return;
      }
      const result = await runRefresh({
        cwd: process.cwd(),
        noPull: flags.pull === false,
        ...(flags.targetOrg !== undefined ? { targetOrg: flags.targetOrg } : {}),
        ...(flags.types !== undefined ? { types: flags.types } : {}),
        ...(flags.withToolingApi === true ? { withToolingApi: true } : {}),
        ...(flags.withDataShape === true ? { withDataShape: true } : {}),
        ...(flags.incremental === true ? { incremental: true } : {}),
        ...(flags.incrementalGraph === true ? { incrementalGraph: true } : {}),
        ...(flags.withReports === true ? { withReports: true } : flags.reports === false ? { withReports: false } : {}),
        ...(flags.apexAst === false ? { apexAst: false } : {}),
        // Progress goes to stderr so a multi-minute refresh isn't a silent
        // wait; stdout stays reserved for the final summary.
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      process.stdout.write(formatRefreshSummary(result));
      if (result.status !== 'success') process.exit(1);
    });
};
