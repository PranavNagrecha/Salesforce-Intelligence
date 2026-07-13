/// <reference types="vitest/globals" />

/**
 * Static import-graph gate for the ambient-consent-bypass class (Finding
 * #12, the cheap slice — NOT the deep dispatch refactor).
 *
 * The bug class: a tool NOT classified `live` (i.e. plane `vault` or
 * `hybrid`, per `getPlaneByTool()` in `semantic-funnel.ts`) can have a
 * handler file whose transitive VALUE imports reach the live plane's
 * consent/session seam (`live-consent.ts`, `tools/live-plane.ts`,
 * `tools/live-session.ts`). Because the live plane goes AMBIENT once an org
 * holds standing consent (`hasLiveConsent` / `SFI_LIVE_PLANE_ENABLED`), such
 * a tool can silently issue a live read while its own `liveRequired` stays
 * `false` forever — the host never sees a consent signal for it.
 * `coverage-report.ts` is the proven instance: it imports `resolveLiveAccess`
 * from `./live-plane.js` directly while `sfi.coverage_report` is plane
 * `vault`.
 *
 * This test is a GUARD, not a fix — mirrors the `registration-parity.
 * test.ts` ledger philosophy (additive, explicit, self-auditing; a stale or
 * fabricated ledger entry fails its own check). It walks each non-`live`
 * tool's handler file's transitive VALUE-import graph and fails if it
 * reaches a seam file UNLESS the tool is listed in
 * `KNOWN_LIVE_SEAM_VAULT_TOOLS` below. That allowlist is seeded with every
 * CURRENT reacher so the gate is green today; it exists to catch the NEXT
 * one, not to relitigate these — the actual fixes (threading explicit
 * `liveEnabled: false` through the shared helpers, or splitting the shared
 * code so the vault path never touches `live-plane.ts` at all) are a
 * reviewed follow-up, out of scope here.
 *
 * Resolution is deliberately simple string-level import parsing (a BFS over
 * import specifiers), not a full TS type graph, per two things learned while
 * building it:
 *
 *   1. Only VALUE imports create a graph edge. A whole-statement
 *      `import type { ... }` or a specifier list that is entirely
 *      `type X` is erased at compile time and carries no runtime
 *      reachability. Without this distinction nearly every handler
 *      "reaches" the seam purely through `import type { Context } from
 *      '../server.js'` — a naive whole-file graph flagged 157 of 195 tools
 *      before this fix, all noise.
 *
 *   2. `tools/index.ts` (the dispatch REGISTRY) is a deliberate dead end —
 *      given NO outgoing edges in the graph. It imports every handler in
 *      the codebase, including every `live_*` one, purely to wire up
 *      `dispatchTool`. Any file that merely references the registry (e.g.
 *      for the `V01_TOOLS` roster, as `semantic-funnel.ts` does) would
 *      trivially "reach" every tool transitively through it. Confirmed via
 *      `sfi.route_question`'s false-positive chain during development:
 *      `route-question.ts -> semantic-funnel.ts -> tools/index.ts ->
 *      live-picklist-usage.ts -> live-plane.ts`. Genuine handler-to-handler
 *      composition is unaffected — e.g. `health-check.ts` importing
 *      `buildAssignmentDataCoverage` straight from `coverage-report.ts` is a
 *      direct value-import edge between the two files, never via the
 *      registry.
 *
 * Specifier resolution follows relative imports (`./x.js`, `../x.js`) within
 * `packages/mcp/src`, and `@sf-intelligence/*` imports to that package's
 * `src/index.ts` (no other package reaches back into `packages/mcp`, so this
 * never adds a new seam edge today — it exists so the resolver doesn't
 * silently stop at a package boundary).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPlaneByTool } from '../src/semantic-funnel.js';
import { V01_TOOLS } from '../src/tools/index.js';

const MCP_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOOLS_DIR = join(MCP_SRC_DIR, 'tools');
const PACKAGES_DIR = join(MCP_SRC_DIR, '..', '..');
// R7-F2: handler imports and dispatchTool switch moved to tool-dispatch.ts.
// INDEX_PATH here means "the dispatch file" — point at tool-dispatch.ts.
const INDEX_PATH = join(TOOLS_DIR, 'tool-dispatch.ts');

/** The live-plane consent/session seam this gate watches for ambient reach. */
const SEAM_FILES: ReadonlySet<string> = new Set([
  resolve(MCP_SRC_DIR, 'live-consent.ts'),
  resolve(TOOLS_DIR, 'live-plane.ts'),
  resolve(TOOLS_DIR, 'live-session.ts'),
]);

/**
 * Tools NOT classified `live` (per `getPlaneByTool()`) whose handler file's
 * value-import graph CURRENTLY reaches the live-plane seam. Each entry is a
 * tool that can reach the live plane while not classified live — a
 * follow-up should thread explicit liveEnabled:false; do not add new
 * entries. If a NEW tool ever lands on this list, that IS the bug this gate
 * exists to catch: fix the import (or the shared helper it goes through),
 * don't allowlist it. Adding an entry here is a deliberate, reviewed
 * exception, tracked, not a silent gap.
 *
 * hybrid (2) — reach live BY DESIGN. Plane `hybrid` means "vault-primary
 * answer with an optional live enrichment fused in" (see the
 * `PLANE_OVERRIDES` doc comment in `semantic-funnel.ts`), so touching the
 * seam is the documented contract, not a leak — listed anyway because the
 * task scope is literally "every tool not classified live":
 *   - sfi.field_cleanup_candidates (packages/mcp/src/tools/synthesis-reports.ts)
 *   - sfi.unused_fields_deep       (packages/mcp/src/tools/unused-fields-deep.ts)
 *
 * vault (10) — NOT expected to reach live; each is a real finding for the
 * follow-up to review:
 *   - sfi.coverage_report              — imports `resolveLiveAccess`
 *     directly from `./live-plane.js` (the originally-proven instance).
 *   - sfi.what_if_make_field_required  — imports `resolveLiveAccess` +
 *     `assertSoqlIdentifier` + `checkVaultStaleness` from `./live-plane.js`
 *     and `liveCount` from `./live-session.js` directly.
 *   - sfi.safe_to_delete_field         — imports `computeLivePopulation`
 *     from `./live-population-check.js` (the `live_field_population`
 *     helper, which itself imports `resolveLiveAccess`/`liveCount`).
 *   - sfi.health_check                 — imports `buildAssignmentDataCoverage`
 *     from `./coverage-report.js`.
 *   - sfi.field_change_advisor         — composes BOTH
 *     `safeToDeleteFieldHandler` and `whatIfMakeFieldRequiredHandler`, so it
 *     inherits both of the above chains.
 *   - sfi.tech_debt_score              — imports from
 *     `./unused-fields-deep.js` (the hybrid tool above).
 *   - sfi.org_risk_report, sfi.automation_risk_report,
 *     sfi.permission_risk_report, sfi.release_readiness_report — all four
 *     live in `./synthesis-reports.ts`, which imports `healthCheckHandler`
 *     from `./health-check.js` (chain 4 above) AND
 *     `fieldCleanupCandidatesHandler` (the hybrid tool).
 */
const KNOWN_LIVE_SEAM_VAULT_TOOLS: ReadonlySet<string> = new Set([
  // hybrid — by design
  'sfi.field_cleanup_candidates',
  'sfi.unused_fields_deep',
  // vault — real findings for the follow-up
  'sfi.coverage_report',
  'sfi.what_if_make_field_required',
  'sfi.safe_to_delete_field',
  'sfi.health_check',
  'sfi.field_change_advisor',
  'sfi.tech_debt_score',
  'sfi.org_risk_report',
  'sfi.automation_risk_report',
  'sfi.permission_risk_report',
  'sfi.release_readiness_report',
]);

interface ParsedImport {
  readonly wholeStatementTypeOnly: boolean;
  readonly specifiers: readonly string[];
  readonly moduleSpecifier: string;
}

/**
 * Matches `import [type] { specifiers } from '<spec>';` where `<spec>` is
 * either a relative import ending in the explicit `.js` extension NodeNext
 * resolution requires, or a bare `@sf-intelligence/<pkg>` package root
 * import. The specifier body is bounded by `[^{}]*` (never a lazy
 * `[\s\S]*?`) so one match can't run past its own closing brace into a
 * later, unrelated import — the same care `registration-parity.test.ts`
 * documents for its own import-block regex.
 */
const importStatementRe =
  /import\s+(type\s+)?\{([^{}]*)\}\s*from\s*'((?:\.[^']+\.js)|(?:@sf-intelligence\/[a-zA-Z0-9_-]+))';/g;

const parseImports = (source: string): readonly ParsedImport[] => {
  const out: ParsedImport[] = [];
  const re = new RegExp(importStatementRe.source, 'g');
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = re.exec(source))) {
    const specifiers = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({
      wholeStatementTypeOnly: Boolean(m[1]),
      specifiers,
      moduleSpecifier: m[3] ?? '',
    });
  }
  return out;
};

/** Local binding name a specifier introduces, stripping `X as Y` and `type `. */
const localNameOf = (specifier: string): string => {
  const parts = specifier.split(' as ');
  const raw = (parts.length > 1 ? parts[1] : parts[0]) ?? '';
  return raw.trim().replace(/^type\s+/, '');
};

const fileExistsCache = new Map<string, boolean>();
const isFile = (path: string): boolean => {
  const cached = fileExistsCache.get(path);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    exists = statSync(path).isFile();
  } catch {
    exists = false;
  }
  fileExistsCache.set(path, exists);
  return exists;
};

/**
 * Resolve one import's module specifier to an absolute `.ts` file, or
 * `null` if it can't be resolved on disk (e.g. an external bare package
 * like `zod` — those never reach the seam and are not modeled).
 */
const resolveSpecifier = (fromFile: string, moduleSpecifier: string): string | null => {
  let base: string;
  if (moduleSpecifier.startsWith('@sf-intelligence/')) {
    const pkgName = moduleSpecifier.slice('@sf-intelligence/'.length).split('/')[0];
    if (!pkgName) return null;
    base = join(PACKAGES_DIR, pkgName, 'src', 'index');
  } else if (moduleSpecifier.startsWith('.')) {
    // Strip the explicit `.js` NodeNext resolution requires on relative
    // specifiers before resolving against the real `.ts` source tree.
    const withoutExt = moduleSpecifier.endsWith('.js')
      ? moduleSpecifier.slice(0, -'.js'.length)
      : moduleSpecifier;
    base = resolve(dirname(fromFile), withoutExt);
  } else {
    return null;
  }
  const asFile = `${base}.ts`;
  if (isFile(asFile)) return asFile;
  const asIndex = join(base, 'index.ts');
  if (isFile(asIndex)) return asIndex;
  return null;
};

/**
 * The body of the `dispatchTool` switch statement, isolated by
 * brace-counting from `switch (toolName) {` to its matching close — the
 * same technique `registration-parity.test.ts` uses, so this stays robust
 * to reordering and nested blocks inside a case.
 */
const dispatchSwitchBody = (indexSource: string): string => {
  const marker = 'switch (toolName) {';
  const start = indexSource.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'plane-import-guard: could not locate `switch (toolName) {` in ' +
        'tools/index.ts — the dispatch shape changed, update this test',
    );
  }
  let depth = 0;
  let i = start + marker.length - 1;
  for (; i < indexSource.length; i++) {
    const ch = indexSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(
      'plane-import-guard: unbalanced braces while isolating the dispatchTool switch body',
    );
  }
  return indexSource.slice(start, i + 1);
};

/** Every local binding `tools/index.ts` imports, mapped to its home file. */
const importedSymbolToFile = (indexSource: string): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const imp of parseImports(indexSource)) {
    const file = resolveSpecifier(INDEX_PATH, imp.moduleSpecifier);
    if (!file) continue;
    for (const specifier of imp.specifiers) {
      const local = localNameOf(specifier);
      if (local) map.set(local, file);
    }
  }
  return map;
};

interface ToolHandlerFiles {
  readonly toolName: string;
  readonly files: readonly string[];
}

/**
 * For every `case 'sfi.x':` in the dispatch switch, the set of home files
 * for every imported identifier referenced in that case's body. Covers both
 * the normal `runTool(ctx, args, xInputSchema, xHandler)` shape AND an
 * inline gateway case like `sfi.run_analysis` (which calls
 * `resolveRunAnalysis` / `KNOWN_TOOL_NAMES` from `catalog-gateway.ts`
 * instead of a dedicated `*Handler`) — scanning every identifier rather than
 * only `*Handler`-suffixed ones is what makes that case resolve too.
 */
const toolHandlerFiles = (
  switchBody: string,
  symbolToFile: ReadonlyMap<string, string>,
): readonly ToolHandlerFiles[] => {
  const caseRe = /case '(sfi\.[a-zA-Z0-9_]+)':/g;
  const caseStarts: Array<{ readonly name: string; readonly index: number }> = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = caseRe.exec(switchBody))) {
    const name = m[1];
    if (name) caseStarts.push({ name, index: m.index });
  }
  const identifierRe = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const out: ToolHandlerFiles[] = [];
  for (let idx = 0; idx < caseStarts.length; idx++) {
    const entry = caseStarts[idx];
    if (!entry) continue;
    const nextIndex = caseStarts[idx + 1]?.index ?? switchBody.length;
    const body = switchBody.slice(entry.index, nextIndex);
    const files = new Set<string>();
    const idRe = new RegExp(identifierRe.source, 'g');
    let idMatch: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
    while ((idMatch = idRe.exec(body))) {
      const file = symbolToFile.get(idMatch[0]);
      if (file) files.add(file);
    }
    out.push({ toolName: entry.name, files: [...files] });
  }
  return out;
};

/** Every non-test `.ts` file under `dir`, recursively. */
const listSourceFiles = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Value-import adjacency for every source file under `packages/mcp/src`.
 * `tools/index.ts` is deliberately given NO outgoing edges — see the
 * file-level comment for why treating the dispatch registry as a normal
 * graph node produces a false-positive explosion.
 */
const buildImportGraph = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const file of listSourceFiles(MCP_SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    const targets = new Set<string>();
    for (const imp of parseImports(source)) {
      if (imp.wholeStatementTypeOnly) continue; // erased at compile time
      const hasValueSpecifier = imp.specifiers.some((s) => !/^type\s+/.test(s));
      if (!hasValueSpecifier) continue; // every specifier is `type X` — also erased
      const target = resolveSpecifier(file, imp.moduleSpecifier);
      if (target) targets.add(target);
    }
    graph.set(file, targets);
  }
  graph.set(INDEX_PATH, new Set());
  return graph;
};

/** BFS from `startFiles`; returns the first seam file reached, or `null`. */
const reachesSeam = (
  startFiles: readonly string[],
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string | null => {
  const seen = new Set<string>();
  const queue: string[] = [...startFiles];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) return null;
    if (seen.has(current)) continue;
    seen.add(current);
    if (SEAM_FILES.has(current)) return current;
    for (const next of graph.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
};

describe('plane import guard — ambient live-plane reach from a non-live tool', () => {
  const indexSource = readFileSync(INDEX_PATH, 'utf8');
  const symbolToFile = importedSymbolToFile(indexSource);
  const switchBody = dispatchSwitchBody(indexSource);
  const handlerFilesByTool = new Map(
    toolHandlerFiles(switchBody, symbolToFile).map((t) => [t.toolName, t.files] as const),
  );
  const importGraph = buildImportGraph();
  const planeByTool = getPlaneByTool();
  const nonLiveToolNames = V01_TOOLS.filter(
    (t) => planeByTool.get(t.name)?.plane !== 'live',
  ).map((t) => t.name);

  it('scans a non-trivial number of non-live tools (sanity guard against a silently-empty roster)', () => {
    expect(nonLiveToolNames.length).toBeGreaterThan(100);
  });

  it('resolves at least one handler file for every non-live tool from tools/index.ts', () => {
    for (const toolName of nonLiveToolNames) {
      const files = handlerFilesByTool.get(toolName) ?? [];
      expect(
        files.length,
        `${toolName}: no handler file resolved from the dispatchTool switch — ` +
          'the identifier scan in toolHandlerFiles() missed it, update this test',
      ).toBeGreaterThan(0);
    }
  });

  it.each(nonLiveToolNames)(
    '%s (non-live) does not transitively import the live-plane seam, unless it is a reviewed KNOWN_LIVE_SEAM_VAULT_TOOLS exception',
    (toolName) => {
      const files = handlerFilesByTool.get(toolName) ?? [];
      const hit = reachesSeam(files, importGraph);
      if (KNOWN_LIVE_SEAM_VAULT_TOOLS.has(toolName)) {
        // A ledger entry that no longer reaches the seam is stale — prove
        // the ledger doesn't silently rot into a lie, same as
        // registration-parity's KNOWN_UNREGISTERED_HANDLERS freshness check.
        expect(
          hit,
          `${toolName} is listed in KNOWN_LIVE_SEAM_VAULT_TOOLS but its handler ` +
            'no longer reaches the live-plane seam — remove the stale entry',
        ).not.toBeNull();
        return;
      }
      expect(
        hit,
        `${toolName} is plane '${planeByTool.get(toolName)?.plane}' (not live) but its ` +
          `handler transitively imports the live-plane seam (${String(hit)}) — this tool ` +
          'can go live on standing consent without its own liveRequired flag ever being ' +
          'true. Either sever the import, or add a reviewed KNOWN_LIVE_SEAM_VAULT_TOOLS ' +
          'entry with a comment explaining the chain.',
      ).toBeNull();
    },
  );

  it('KNOWN_LIVE_SEAM_VAULT_TOOLS has no stale entries (every listed tool is real and still non-live)', () => {
    const toolNames = new Set(V01_TOOLS.map((t) => t.name));
    for (const name of KNOWN_LIVE_SEAM_VAULT_TOOLS) {
      expect(
        toolNames.has(name),
        `${name} is listed in KNOWN_LIVE_SEAM_VAULT_TOOLS but is not a real V01_TOOLS entry — remove it`,
      ).toBe(true);
      expect(
        planeByTool.get(name)?.plane,
        `${name} is listed in KNOWN_LIVE_SEAM_VAULT_TOOLS but is classified 'live' — ` +
          'the allowlist is only for non-live tools, remove it (a live tool reaching the ' +
          'seam is expected, not a finding)',
      ).not.toBe('live');
    }
  });
});
