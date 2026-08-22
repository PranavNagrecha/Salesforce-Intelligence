/**
 * Duplicate-source detection and precedence (import layer).
 *
 * ## The bug this exists to close
 *
 * A vault's `org-kb/source/` tree can end up holding TWO complete copies of the
 * same retrieval target — typically a legacy flat layout (`source/profiles/…`,
 * written by older refreshes) sitting alongside the Salesforce DX layout the
 * current refresh writes (`source/main/default/profiles/…`). Nothing removed the
 * first tree when the second landed, so both are walked, both are extracted, and
 * both reach the importer.
 *
 * What the importer did with them was silent and wrong in two different ways:
 *
 *   - **Nodes** are written with `INSERT OR REPLACE` (last-writer-wins on id).
 *     The walker visits directories in alphabetical order, so `main/` is walked
 *     BEFORE `profiles/` — meaning the OLDER flat copy overwrote the NEWER DX
 *     copy. A permission revoked in the newer retrieval read back as still
 *     granted, because the node the graph kept was the stale one. Nothing in
 *     `vaultState`, the manifest, or the node itself said so.
 *   - **Edges** are written with `INSERT OR IGNORE` (first-writer-wins on the
 *     composite key), so the two copies' edge sets were UNIONED. A grant present
 *     in either copy survived. That manufactures a component that existed in
 *     NEITHER retrieval — the worst possible answer for a product whose premise
 *     is that a confident answer from data that does not support it is worse
 *     than no answer.
 *
 * This module makes the assembly explicit: it detects the duplicates, picks ONE
 * copy by a stated rule, drops the other copy's nodes AND its edges (never a
 * union), and flags every component whose copies disagreed so a tool answering
 * about it can disclose that it did.
 *
 * ## Precedence, and why
 *
 * The winner is the **DX-canonical copy** — the one whose path contains the
 * `main/default/` package-directory pair. Defence:
 *
 *   1. It is the only layout the product's own retrieve writes today
 *      (`<pkgDir>/main/default/<type>/…`), and the only layout an
 *      `sfdx-project.json` declares as a package directory. A copy outside every
 *      declared package directory is residue of an older run, not a second
 *      retrieval target.
 *   2. "Newest wins" is NOT implementable honestly here, and picking it would be
 *      picking by convenience:
 *        - File mtime does not survive a copy, clone, archive-restore, or
 *          `sf project retrieve` into a fresh directory, so it cannot be trusted
 *          to order two trees.
 *        - The vault's `meta/retrieval-ledger.json` records `retrievedAt` per
 *          metadata FAMILY (one row per `ComponentType`), never per path. On a
 *          real duplicated vault it carries exactly ONE `Profile` row — it
 *          cannot say which of two `profiles/` directories that row describes.
 *        There is no per-path retrieval metadata anywhere in the vault, so a
 *        "newest" rule would be a guess wearing a timestamp.
 *   3. The rule is deterministic and order-independent, so two builds of the
 *      same tree produce the same graph. The status quo was neither: the winner
 *      was whichever file the alphabetical walk happened to reach last.
 *
 * ## What the rule does NOT claim
 *
 * `main/default` winning is a CONVENTION about layout, not proof of recency. If
 * the DX copy is in fact the older one, choosing it DROPS a permission that
 * exists only in the flat copy — a false denial. That is the safer of the two
 * failures (the status quo produced a false GRANT, which is what an attacker or
 * a careless admin benefits from), but it is still a failure, so the choice is
 * NEVER made silently:
 *
 *   - every component whose copies differ carries {@link SOURCE_CONFLICT_PROPERTY}
 *     in its node properties, naming both paths and which one was used;
 *   - the whole-vault roll-up ({@link DuplicateSourceSummary}) names the
 *     duplicated layout roots and the counts, and is written to the manifest so
 *     `health_check` can refuse to call the vault healthy.
 *
 * Where the rule cannot discriminate — neither copy is DX-canonical, or BOTH are
 * (two package directories) — we do not pretend to know. The winner is then the
 * lexicographically first path, chosen ONLY so the build is reproducible, and
 * the disclosure says `precedence: 'undetermined'`. A flagged conflict an admin
 * resolves beats a silent pick.
 *
 * ## What was deliberately NOT chosen
 *
 *   - *Refuse to import an ambiguous tree.* It would brick every existing vault
 *     that has this shape, including ones whose duplicate copies are identical
 *     and harmless. Disclosure gets the operator the same information without
 *     taking their vault away.
 *   - *Keep the union and mark the conflicting fields.* That leaves the false
 *     grant in place and asks the reader to notice a footnote. The union is the
 *     defect.
 */

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { relativizeSourcePath } from './relativize.js';

/**
 * Node-properties key carrying the per-component duplicate-source disclosure.
 * Present ONLY on components whose copies disagreed, so a vault with no
 * duplicates (or with byte-identical duplicates) is byte-unchanged.
 */
export const SOURCE_CONFLICT_PROPERTY = 'sourceConflict';

/** How the winning copy was chosen for one duplicated component. */
export type SourcePrecedence = 'dx-canonical' | 'undetermined';

/**
 * The disclosure stamped onto a conflicted component's node properties under
 * {@link SOURCE_CONFLICT_PROPERTY}. Deliberately small: the long explanation
 * lives in the manifest roll-up and `health_check`, because this rides on every
 * affected node and competes with the MCP response byte budget.
 */
export interface SourceConflictDisclosure {
  /** Always true — the key is absent when the copies agree. */
  readonly conflicting: true;
  /** Every vault-relative path this component was found at, sorted. */
  readonly paths: readonly string[];
  /** The copy this node's content came from. */
  readonly chosenPath: string;
  /** Which rule chose it. `undetermined` = picked for reproducibility only. */
  readonly precedence: SourcePrecedence;
  /** One-line, reader-facing statement of what happened. */
  readonly disclosure: string;
}

/** Whole-vault roll-up, written to the manifest by the refresh. */
export interface DuplicateSourceSummary {
  /** Components found at more than one source path. */
  readonly components: number;
  /** Of those, how many had DIFFERING content between copies. */
  readonly conflicting: number;
  /** Of the conflicting ones, how many could not be ordered by the DX rule. */
  readonly undeterminedPrecedence: number;
  /** The distinct duplicated layout roots, e.g. `source/` and `source/main/default/`. */
  readonly paths: readonly string[];
  /** Conflicting-component counts per `ComponentType`. */
  readonly byType: Readonly<Record<string, number>>;
  /** Reader-facing statement of what the vault is and what to do about it. */
  readonly disclosure: string;
}

/** What {@link resolveDuplicateSourcePaths} hands back. */
export interface DuplicateSourceResolution {
  /** `results` with losing copies removed and conflicts flagged. */
  readonly results: readonly ExtractionResult[];
  /** `null` when no component appeared at more than one path (the normal vault). */
  readonly summary: DuplicateSourceSummary | null;
}

/**
 * True when `path` sits inside a Salesforce DX package directory
 * (`…/main/default/…`) — the layout `sf project retrieve` and this product's
 * refresh write, and the only layout `sfdx-project.json` declares as source.
 */
export const isDxCanonicalPath = (path: string): boolean =>
  /(?:^|\/)main\/default\//.test(path);

/**
 * Pick which of several paths for the SAME component id wins. See the module
 * doc for the defence; the short version is DX-canonical wins, and when that
 * cannot discriminate we say so rather than guess.
 */
export const chooseSourcePath = (
  paths: readonly string[],
): { readonly chosen: string; readonly precedence: SourcePrecedence } => {
  const sorted = [...paths].sort();
  const dx = sorted.filter(isDxCanonicalPath);
  if (dx.length === 1) return { chosen: dx[0]!, precedence: 'dx-canonical' };
  // Zero DX copies (two legacy trees) or several (multiple package dirs): the
  // convention cannot order them. Lexicographic keeps the build reproducible;
  // `undetermined` keeps the answer honest about why this copy was used.
  return { chosen: sorted[0]!, precedence: 'undetermined' };
};

/**
 * Stable JSON for comparing two copies of a node. Not the persisted
 * `canonicalJson` (that one is the DB row serializer and lives in `import.ts`);
 * this only needs a deterministic equality key, so it stays local rather than
 * creating an import cycle.
 */
const stableJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * Comparison key for one copy of a component: everything the node carries
 * EXCEPT its source path (which is the thing that differs by construction),
 * plus the edges that copy minted for it. Edges are included because a grant is
 * an edge for most families — comparing node properties alone would call two
 * copies "identical" while their permission grants differed.
 */
const copyContentKey = (node: Node, incidentEdges: readonly Edge[]): string =>
  stableJson({
    type: node.type,
    apiName: node.apiName,
    label: node.label,
    parentId: node.parentId,
    lastModifiedDate: node.lastModifiedDate,
    lastModifiedBy: node.lastModifiedBy,
    apiVersion: node.apiVersion,
    properties: node.properties,
    edges: [...incidentEdges]
      .map((e) =>
        stableJson({
          fromId: e.fromId,
          toId: e.toId,
          edgeType: e.edgeType,
          confidence: e.confidence,
          source: e.source,
          properties: e.properties,
        }),
      )
      .sort(),
  });

/** Segment-wise longest common SUFFIX length across every path in a group. */
const commonSuffixSegments = (paths: readonly string[]): number => {
  const split = paths.map((p) => p.split('/'));
  const shortest = Math.min(...split.map((s) => s.length));
  let n = 0;
  while (n < shortest) {
    const seg = split[0]![split[0]!.length - 1 - n];
    if (!split.every((s) => s[s.length - 1 - n] === seg)) break;
    n += 1;
  }
  return n;
};

/**
 * The layout root each path in a duplicate group sits under — the path with the
 * shared logical tail removed. `source/profiles/X.profile-meta.xml` and
 * `source/main/default/profiles/X.profile-meta.xml` yield `source/` and
 * `source/main/default/`, which is what the manifest names for the operator.
 */
const layoutRoots = (paths: readonly string[]): readonly string[] => {
  const tail = commonSuffixSegments(paths);
  const roots = paths.map((p) => {
    const segs = p.split('/');
    const head = segs.slice(0, Math.max(0, segs.length - tail));
    return head.length === 0 ? '(source tree root)' : `${head.join('/')}/`;
  });
  return roots;
};

/** Per-node bookkeeping while scanning the incoming results. */
interface NodeSite {
  readonly resultIndex: number;
  readonly nodeIndex: number;
  readonly path: string;
  readonly node: Node;
}

/**
 * Detect components present at more than one source path, choose one copy per
 * {@link chooseSourcePath}, drop the losing copies' nodes AND the edges those
 * copies minted, and stamp {@link SOURCE_CONFLICT_PROPERTY} on every component
 * whose copies disagreed.
 *
 * Pure and idempotent: running it on an already-resolved result set finds no
 * duplicates and returns the input array unchanged (same reference), so it is
 * safe to call at more than one layer. A vault with no duplicates pays one map
 * build and nothing else.
 *
 * @example
 *   const { results, summary } = resolveDuplicateSourcePaths(walked.results);
 *   if (summary !== null) console.warn(summary.disclosure);
 */
export const resolveDuplicateSourcePaths = (
  results: readonly ExtractionResult[],
): DuplicateSourceResolution => {
  const sitesById = new Map<string, NodeSite[]>();
  for (let ri = 0; ri < results.length; ri += 1) {
    const nodes = results[ri]!.nodes;
    for (let ni = 0; ni < nodes.length; ni += 1) {
      const node = nodes[ni]!;
      const path = relativizeSourcePath(node.sourcePath);
      const list = sitesById.get(node.id);
      if (list === undefined) sitesById.set(node.id, [{ resultIndex: ri, nodeIndex: ni, path, node }]);
      else list.push({ resultIndex: ri, nodeIndex: ni, path, node });
    }
  }

  // Only ids seen at MORE THAN ONE distinct path are duplicates. The same id at
  // the same path twice is the pre-existing co-emission / enrichment pattern
  // (e.g. the describe-snapshot overlay re-emitting an enriched CustomField with
  // the ORIGINAL `sourcePath`); last-writer-wins is correct there and must not
  // be disturbed.
  const duplicates: Array<{ readonly id: string; readonly sites: readonly NodeSite[] }> = [];
  for (const [id, sites] of sitesById) {
    if (sites.length < 2) continue;
    const distinctPaths = new Set(sites.map((s) => s.path));
    if (distinctPaths.size < 2) continue;
    duplicates.push({ id, sites });
  }
  if (duplicates.length === 0) return { results, summary: null };

  // Edges incident to a given node id WITHIN one result — the edges that one
  // copy minted for that component.
  const incidentEdges = (resultIndex: number, id: string): readonly Edge[] =>
    results[resultIndex]!.edges.filter((e) => e.fromId === id || e.toId === id);

  /** resultIndex -> node ids of this result that lost precedence. */
  const losersByResult = new Map<number, Set<string>>();
  /** `${resultIndex}:${nodeIndex}` -> disclosure to stamp on the winning node. */
  const conflictStamps = new Map<string, SourceConflictDisclosure>();
  const allRoots = new Set<string>();
  const byType: Record<string, number> = {};
  let conflicting = 0;
  let undeterminedPrecedence = 0;

  for (const { id, sites } of duplicates) {
    const paths = [...new Set(sites.map((s) => s.path))].sort();
    for (const root of layoutRoots(paths)) allRoots.add(root);
    const { chosen, precedence } = chooseSourcePath(paths);

    const contentKeys = new Set(
      sites.map((s) => copyContentKey(s.node, incidentEdges(s.resultIndex, id))),
    );
    const isConflicting = contentKeys.size > 1;
    if (isConflicting) {
      conflicting += 1;
      const type = sites[0]!.node.type;
      byType[type] = (byType[type] ?? 0) + 1;
      if (precedence === 'undetermined') undeterminedPrecedence += 1;
    }

    // The winner is the LAST site on the chosen path: within one path, the
    // pre-existing last-writer-wins ordering still decides (that is the
    // enrichment-overlay contract), and only the CROSS-path choice changes.
    let winner: NodeSite | null = null;
    for (const site of sites) {
      if (site.path === chosen) winner = site;
    }
    for (const site of sites) {
      if (site === winner) continue;
      if (site.path === chosen) continue; // same-path predecessor: leave it alone
      let set = losersByResult.get(site.resultIndex);
      if (set === undefined) {
        set = new Set<string>();
        losersByResult.set(site.resultIndex, set);
      }
      set.add(id);
    }

    if (isConflicting && winner !== null) {
      conflictStamps.set(`${winner.resultIndex}:${winner.nodeIndex}`, {
        conflicting: true,
        paths,
        chosenPath: chosen,
        precedence,
        disclosure:
          precedence === 'dx-canonical'
            ? `This component exists at ${paths.length} source paths in the vault with DIFFERENT content. Answered from the Salesforce DX copy (${chosen}); the other copy was NOT merged in. Re-retrieve and delete the stale tree before treating any grant or property here as settled.`
            : `This component exists at ${paths.length} source paths in the vault with DIFFERENT content, and the vault holds NO metadata that says which retrieval is newer. Answered from ${chosen}, chosen only so the build is reproducible. Resolve the duplicate tree before treating any grant or property here as settled.`,
      });
    }
  }

  const rewritten: ExtractionResult[] = results.map((result, ri) => {
    const losers = losersByResult.get(ri);
    const hasStamp = result.nodes.some((_, ni) => conflictStamps.has(`${ri}:${ni}`));
    if (losers === undefined && !hasStamp) return result;
    const nodes: Node[] = [];
    for (let ni = 0; ni < result.nodes.length; ni += 1) {
      const node = result.nodes[ni]!;
      if (losers !== undefined && losers.has(node.id)) continue;
      const stamp = conflictStamps.get(`${ri}:${ni}`);
      nodes.push(
        stamp === undefined
          ? node
          : { ...node, properties: { ...node.properties, [SOURCE_CONFLICT_PROPERTY]: stamp } },
      );
    }
    // Drop the edges the LOSING copy minted. Filtering by "incident to a losing
    // id" is safe because it is scoped to THIS result — the winning copy's
    // identical-looking edges live in a different result and survive. Without
    // this the two copies' edge sets would still be unioned by the importer's
    // `INSERT OR IGNORE`, which is the false-grant path.
    const edges =
      losers === undefined
        ? result.edges
        : result.edges.filter((e) => !losers.has(e.fromId) && !losers.has(e.toId));
    return { nodes, edges };
  });

  const paths = [...allRoots].sort();
  const summary: DuplicateSourceSummary = {
    components: duplicates.length,
    conflicting,
    undeterminedPrecedence,
    paths,
    byType,
    disclosure:
      `This vault's source tree holds the same components under ${paths.length} different roots (${paths.join(', ')}) — ` +
      `${duplicates.length} component(s) were present at more than one path, ${conflicting} of them with DIFFERING content. ` +
      `Copies were NOT merged: one copy per component was used (Salesforce DX \`main/default\` layout preferred; ` +
      `${undeterminedPrecedence} conflict(s) could not be ordered and were resolved lexicographically for reproducibility only). ` +
      `The vault records no per-path retrieval time, so which tree is NEWER cannot be determined from the vault. ` +
      `Treat permission, field and property answers for the affected components as UNRESOLVED until the stale tree is deleted and the vault re-refreshed.`,
  };

  return { results: rewritten, summary };
};
