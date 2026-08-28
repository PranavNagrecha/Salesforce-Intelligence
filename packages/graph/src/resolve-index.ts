/**
 * Inverted index for the resolver — turns the per-call full node scan into a
 * candidate prefilter, so resolution stays O(matching candidates) instead of
 * O(all nodes). This is the SCALE work flagged in `resolve.ts`: at a few
 * thousand nodes the full scan is sub-100ms, but it grows linearly; the index
 * keeps resolution interactive on 50k-node orgs.
 *
 * **Recall safety.** The prefilter must never drop a node the full scan would
 * have matched. A candidate is gathered if it shares, with any query token:
 *   - an exact token (covers exact + substring-containment matches), OR
 *   - a character bigram (covers substitution/insertion/deletion typos — those
 *     change at most two bigrams, so a match at/above the floor shares ≥1), OR
 *   - a sorted-character signature (covers TRANSPOSITION typos, which can
 *     destroy every bigram of a short token — `test`→`tset` shares no bigram
 *     yet scores ~0.92 — but never change the character multiset), OR
 *   - a synonym-expanded exact token (covers synonym bridges like rep↔owner,
 *     which share NO bigram and so need explicit expansion), OR
 *   - the whole normalized name equals the whole normalized query (the
 *     whole-name exact boost, robust to tokenizer chunking).
 * The union of these is a superset of everything the scan could score above the
 * floor, so recall is preserved (verified against the stress harness: exact
 * recall 100%, typo recall unchanged after indexing).
 *
 * **Caching.** The index is built once per `GraphStore` and memoized in a
 * module-level `WeakMap`. A cheap row-count guard rebuilds it if the node count
 * changed (e.g. a fresh import in a long-lived process); a normal MCP session
 * loads the graph once and reuses the index for every resolve.
 *
 * **Persistence.** `sfi refresh` writes `{graphDir}/resolve-index.json` beside
 * `graph.duckdb` after a complete graph publish. Cold MCP processes load that
 * artifact when `graphDbPath` is supplied to {@link getResolveIndex}, avoiding
 * a full rebuild on the first resolve.
 *
 * **Identity, not arithmetic** (RESOLVE-INDEX-DISCARDED-GENERATION). The
 * persisted artifact used to be validated by node COUNT alone. That is a
 * checksum with one byte of entropy, and the refresh pipeline hands it the
 * exact input it cannot survive: `sfi refresh` rebuilds into a SIDE file
 * (`graph.duckdb.rebuild`) and renames it over the live database, while the
 * index is written by DIRNAME — so both builds write the SAME
 * `resolve-index.json`. When that rename fails (Windows will not replace a
 * database another process holds open) the scratch database is deleted and the
 * live database is left beside the index of the build that LOST. Two
 * generations of one org routinely share a node count, so the discarded index
 * was accepted and `sfi.resolve` answered `disposition: 'exact'`, score 0.9,
 * `exact name match on "…"` for a class the open database had never contained.
 * On the first tool of the core spine, in a product whose whole claim is that
 * absence is distinguishable from ignorance.
 *
 * The guard is now CONTENT-ADDRESSED: {@link computeGraphFingerprint} digests
 * exactly the graph state the index is derived from, the digest is stamped onto
 * the index at build time, and a load is accepted only when the live graph
 * digests to the same value. `nodeCount` survives as what it always should have
 * been — a sub-millisecond pre-filter that short-circuits the common stale case
 * before the digest is paid for, never the decision.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DuckDBValue } from '@duckdb/node-api';

import type { GraphStore } from './store.js';
import {
  charBigrams,
  expandSynonyms,
  normalizeName,
  sortedChars,
  tokenizeIdentifier,
  tokenizeText,
} from './tokenize.js';

/** One node, pre-tokenized for scoring (so resolution never re-tokenizes). */
export interface IndexedNode {
  readonly id: string;
  readonly type: string;
  readonly apiName: string;
  readonly label: string | null;
  readonly parentApiName: string | null;
  readonly parentId: string | null;
  /** Distinct lowercase tokens from api_name + label. */
  readonly tokens: readonly string[];
  readonly normName: string;
  /** Inbound reference count (popularity prior). */
  readonly inbound: number;
}

export interface ResolveIndex {
  readonly nodes: readonly IndexedNode[];
  /** exact token -> node indices. */
  readonly byToken: ReadonlyMap<string, readonly number[]>;
  /** char bigram -> node indices. */
  readonly byBigram: ReadonlyMap<string, readonly number[]>;
  /** sorted-character signature -> node indices (transposition prefilter). */
  readonly bySortedChars: ReadonlyMap<string, readonly number[]>;
  /** normalized whole name -> node indices. */
  readonly byNormName: ReadonlyMap<string, readonly number[]>;
  /**
   * Node count at build time. A CHEAP PRE-FILTER only — it decides nothing.
   * See {@link fingerprint} and the file header.
   */
  readonly nodeCount: number;
  /**
   * Identity of the graph this index was built from
   * ({@link computeGraphFingerprint}). The value that decides whether a
   * persisted index may be adopted by an open database.
   */
  readonly fingerprint: string;
}

type Row = Readonly<Record<string, unknown>>;

/**
 * The node-count query. One constant, used by BOTH cache guards — it was two
 * hand-copied string literals, which is the shape this codebase's defects keep
 * taking (a second copy kept in step by nothing but proximity).
 */
const NODE_COUNT_SQL = `SELECT count(*)::INT AS c FROM nodes`;

/**
 * Digest EXACTLY the graph state {@link buildResolveIndex} consumes, and
 * nothing else — so "the fingerprint matches" and "the index is still valid"
 * are the same statement rather than two that can drift apart:
 *
 *   - `id, type, api_name, label, parent_id` per node. These are every column
 *     the index reads. `parentApiName` is not listed because it is DERIVED from
 *     the parent's own row, which is itself in the digest — a renamed parent
 *     changes the digest through that row.
 *   - inbound edge counts per target. The index bakes them in as the popularity
 *     prior, so an edge-only change is an index-invalidating change.
 *
 * Runs entirely inside DuckDB: no rows cross into JS, which is what makes this
 * affordable as a validity check, and it is paid ONCE per process (on the cold
 * artifact load), not per resolve. Measured read-only with
 * `enable_external_access=false` — the exact instance config `openGraph` /
 * `openGraphReadOnly` use: ~12ms on a real 9.3k-node / 108k-edge vault, ~40ms
 * on a synthetic 50k / 200k one, against ~75ms just to TRANSFER the node rows
 * at that size and several times that to build the index from them. The node
 * count that pre-filters it costs ~0.7ms.
 *
 * `chr(31)` (unit separator) between columns and `chr(30)` (record separator)
 * terminating each row are control characters no Salesforce API name, label or
 * id can contain, so no combination of field values can be re-flowed into a
 * different graph that digests the same.
 */
const GRAPH_FINGERPRINT_SQL = `
  SELECT
    (SELECT coalesce(md5(string_agg(s, '' ORDER BY s)), 'empty') FROM (
       SELECT concat_ws(
                chr(31), id, type, api_name,
                coalesce(label, chr(1)), coalesce(parent_id, chr(1))
              ) || chr(30) AS s
       FROM nodes
     )) AS nodes_digest,
    (SELECT coalesce(md5(string_agg(s, '' ORDER BY s)), 'empty') FROM (
       SELECT concat_ws(chr(31), to_id, CAST(count(*) AS VARCHAR)) || chr(30) AS s
       FROM edges GROUP BY to_id
     )) AS edges_digest
`;

const push = (m: Map<string, number[]>, key: string, idx: number): void => {
  const arr = m.get(key);
  if (arr === undefined) m.set(key, [idx]);
  else arr.push(idx);
};

const runRows = async (
  store: GraphStore,
  sql: string,
  params: DuckDBValue[],
): Promise<readonly Row[]> => {
  const reader = await store.connection.runAndReadAll(sql, params);
  return reader.getRowObjectsJS() as readonly Row[];
};

/**
 * Digest the graph's identity (see {@link GRAPH_FINGERPRINT_SQL}).
 *
 * Exported so a caller can prove two graphs differ without building an index
 * for either, and so the value the guard compares is reachable from a test.
 */
export const computeGraphFingerprint = async (
  store: GraphStore,
): Promise<string> => {
  const [row] = await runRows(store, GRAPH_FINGERPRINT_SQL, []);
  if (row === undefined) {
    // DuckDB always returns one row for a scalar-subquery SELECT, so this is
    // unreachable in practice. Fail CLOSED anyway with a value no persisted
    // index can ever carry, rather than returning something that might compare
    // equal to a stored digest.
    return `unavailable:${String(Date.now())}:${String(Math.random())}`;
  }
  return `n=${String(row['nodes_digest'])};e=${String(row['edges_digest'])}`;
};

/** Build the index from the current graph state (one full pass). */
export const buildResolveIndex = async (
  store: GraphStore,
): Promise<ResolveIndex> => {
  // ORDER IS LOAD-BEARING: fingerprint FIRST, then read the rows.
  //
  // Nothing here is transactional, so a write landing between the two reads
  // produces an index and a fingerprint that describe different states. Taken
  // in this order the fingerprint is the OLDER of the two, so the artifact is
  // later rejected against the live graph and rebuilt — a wasted rebuild.
  // Reversed, the fingerprint would be the NEWER one, match the live graph,
  // and vouch for an index built from a state that no longer exists: the exact
  // defect this fingerprint was added to close, reintroduced through ordering.
  const fingerprint = await computeGraphFingerprint(store);
  const nodeRows = await runRows(
    store,
    `SELECT n.id, n.type, n.api_name, n.label, n.parent_id, p.api_name AS parent_api_name
     FROM nodes n LEFT JOIN nodes p ON n.parent_id = p.id`,
    [],
  );
  const refRows = await runRows(
    store,
    `SELECT to_id, count(*)::INT AS c FROM edges GROUP BY to_id`,
    [],
  );
  const inbound = new Map<string, number>();
  for (const r of refRows) inbound.set(r['to_id'] as string, Number(r['c']));

  const nodes: IndexedNode[] = [];
  const byToken = new Map<string, number[]>();
  const byBigram = new Map<string, number[]>();
  const bySortedChars = new Map<string, number[]>();
  const byNormName = new Map<string, number[]>();

  for (const row of nodeRows) {
    const apiName = row['api_name'] as string;
    const label = (row['label'] ?? null) as string | null;
    const tokens = [
      ...new Set([
        ...tokenizeIdentifier(apiName),
        ...(label !== null ? tokenizeText(label) : []),
      ]),
    ];
    const normName = normalizeName(apiName);
    const idx = nodes.length;
    nodes.push({
      id: row['id'] as string,
      type: row['type'] as string,
      apiName,
      label,
      parentApiName: (row['parent_api_name'] ?? null) as string | null,
      parentId: (row['parent_id'] ?? null) as string | null,
      tokens,
      normName,
      inbound: inbound.get(row['id'] as string) ?? 0,
    });

    // Index every token, its bigrams, and its sorted-char signature
    // (recall-safe prefilter buckets). Sets dedup within this node.
    const seenBigrams = new Set<string>();
    const seenSorted = new Set<string>();
    for (const t of tokens) {
      push(byToken, t, idx);
      const sig = sortedChars(t);
      if (!seenSorted.has(sig)) {
        seenSorted.add(sig);
        push(bySortedChars, sig, idx);
      }
      for (const bg of charBigrams(t)) {
        if (!seenBigrams.has(`${bg}\u0000${idx}`)) {
          seenBigrams.add(`${bg}\u0000${idx}`);
          push(byBigram, bg, idx);
        }
      }
    }
    if (normName.length > 0) push(byNormName, normName, idx);
  }

  return {
    nodes,
    byToken,
    byBigram,
    bySortedChars,
    byNormName,
    nodeCount: nodes.length,
    fingerprint,
  };
};

/**
 * On-disk format version — bump when the serialized shape changes.
 *
 * The version number is NOT what makes an old artifact safe to reject; the
 * required {@link PersistedResolveIndex.fingerprint} is. An artifact written
 * before that field existed is rejected because it carries no identity, not
 * because of the number it declares — which is the stronger check, since it
 * also catches a current-version payload that lost its identity in transit.
 *
 * Bumped 1 -> 2 in 0.3.3 anyway, for the direction the fingerprint cannot
 * cover: an OLDER `sfi` reading a NEWER artifact. That binary predates the
 * fingerprint, so it ignores the unknown field, sees `version: 1`, and applies
 * its node-count-only guard — which is precisely the defect this release
 * closed, reachable by nothing more than downgrading or by two versions
 * sharing one vault. Old readers reject an unrecognised version outright
 * (`if (o.version !== RESOLVE_INDEX_FORMAT_VERSION) return null`), so raising
 * the number makes them rebuild instead of trusting an index they cannot
 * validate. The fingerprint protects new readers; the version protects us
 * from old ones.
 */
export const RESOLVE_INDEX_FORMAT_VERSION = 2;

/** JSON-serializable resolve index (maps become string-keyed records). */
export interface PersistedResolveIndex {
  readonly version: number;
  readonly nodeCount: number;
  /**
   * The graph identity from {@link computeGraphFingerprint}. REQUIRED: a
   * payload without it is rejected, never adopted on the strength of its node
   * count (see the file header).
   */
  readonly fingerprint: string;
  readonly nodes: readonly IndexedNode[];
  readonly byToken: Readonly<Record<string, readonly number[]>>;
  readonly byBigram: Readonly<Record<string, readonly number[]>>;
  readonly bySortedChars: Readonly<Record<string, readonly number[]>>;
  readonly byNormName: Readonly<Record<string, readonly number[]>>;
}

const mapToRecord = (m: ReadonlyMap<string, readonly number[]>): Record<string, readonly number[]> =>
  Object.fromEntries(m);

const recordToMap = (r: Readonly<Record<string, readonly number[]>>): ReadonlyMap<string, readonly number[]> =>
  new Map(Object.entries(r));

/** Path of the resolve index artifact beside a DuckDB graph file. */
export const resolveIndexPathForGraph = (graphDbPath: string): string =>
  join(dirname(graphDbPath), 'resolve-index.json');

export const serializeResolveIndex = (index: ResolveIndex): PersistedResolveIndex => ({
  version: RESOLVE_INDEX_FORMAT_VERSION,
  nodeCount: index.nodeCount,
  fingerprint: index.fingerprint,
  nodes: index.nodes,
  byToken: mapToRecord(index.byToken),
  byBigram: mapToRecord(index.byBigram),
  bySortedChars: mapToRecord(index.bySortedChars),
  byNormName: mapToRecord(index.byNormName),
});

export const deserializeResolveIndex = (raw: unknown): ResolveIndex | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as PersistedResolveIndex;
  if (o.version !== RESOLVE_INDEX_FORMAT_VERSION) return null;
  if (!Array.isArray(o.nodes) || typeof o.nodeCount !== 'number') return null;
  if (o.nodes.length !== o.nodeCount) return null;
  // FAIL CLOSED on a payload with no identity — an index written by an older
  // `sfi` (which stamped none), or one that lost the field. Such a file may
  // well describe this graph, but "may" is exactly the ambiguity that let a
  // discarded build answer for a live vault, so it is rebuilt instead of
  // guessed at. Rejected here rather than at the comparison below so that a
  // `null` / `0` / `''` / object value can never coerce its way into a match.
  if (typeof o.fingerprint !== 'string' || o.fingerprint.length === 0) return null;
  if (
    o.byToken === null ||
    o.byBigram === null ||
    o.bySortedChars === null ||
    o.byNormName === null ||
    typeof o.byToken !== 'object' ||
    typeof o.byBigram !== 'object' ||
    typeof o.bySortedChars !== 'object' ||
    typeof o.byNormName !== 'object'
  ) {
    return null;
  }
  return {
    nodes: o.nodes,
    byToken: recordToMap(o.byToken),
    byBigram: recordToMap(o.byBigram),
    bySortedChars: recordToMap(o.bySortedChars),
    byNormName: recordToMap(o.byNormName),
    nodeCount: o.nodeCount,
    fingerprint: o.fingerprint,
  };
};

/**
 * Write the resolve index atomically beside `graphDbPath` (`resolve-index.json`).
 * Uses a temp file + rename so readers never see a partial JSON payload.
 */
export const writeResolveIndexArtifact = async (
  graphDbPath: string,
  index: ResolveIndex,
): Promise<void> => {
  const target = resolveIndexPathForGraph(graphDbPath);
  const tmp = `${target}.tmp`;
  const payload = serializeResolveIndex(index);
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(tmp, target);
};

/**
 * Load a persisted index, and adopt it ONLY if it was built from the graph
 * `store` has open — proved by digest, not inferred from a row count.
 *
 * Two guards, in cost order:
 *   1. node count — sub-millisecond, and rejects most stale artifacts outright
 *      without paying for a digest. A PRE-FILTER: passing it proves nothing.
 *   2. {@link computeGraphFingerprint} — the decision. Every mismatch here is
 *      an artifact the old count-only guard would have handed to the resolver:
 *      a discarded side build, a one-for-one renamed component, a relabelled
 *      object, a re-parented field, an edge-only change.
 */
export const tryLoadResolveIndexArtifact = async (
  graphDbPath: string,
  store: GraphStore,
): Promise<ResolveIndex | null> => {
  const path = resolveIndexPathForGraph(graphDbPath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const index = deserializeResolveIndex(parsed);
  if (index === null) return null;
  const [countRow] = await runRows(store, NODE_COUNT_SQL, []);
  if (countRow === undefined || Number(countRow['c']) !== index.nodeCount) return null;
  if ((await computeGraphFingerprint(store)) !== index.fingerprint) return null;
  return index;
};

/** Build the resolve index from the open graph and persist it beside `graphDbPath`. */
export const persistResolveIndexArtifact = async (
  graphDbPath: string,
  store: GraphStore,
): Promise<ResolveIndex> => {
  const built = await buildResolveIndex(store);
  await writeResolveIndexArtifact(graphDbPath, built);
  cache.set(store, built);
  return built;
};

const cache = new WeakMap<GraphStore, ResolveIndex>();

export interface GetResolveIndexOptions {
  /** When set, load `resolve-index.json` beside this DuckDB path before building. */
  readonly graphDbPath?: string;
}

/**
 * Get the (memoized) resolve index for a store, rebuilding only if the node
 * count changed since it was built. The count guard is a single fast query;
 * within a normal session the graph is immutable and the index is reused.
 *
 * SCOPE OF THE COUNT GUARD HERE. This in-memory memo is keyed by `GraphStore`
 * OBJECT identity, so it can only go stale when the SAME open handle sees the
 * graph mutate — never across the refresh swap, which produces a new handle and
 * therefore a new key. It is deliberately NOT upgraded to the digest: the digest
 * costs tens of milliseconds on a large org and this path runs on every single
 * `sfi.resolve` call, where the persisted-artifact check runs once per process.
 * The honest fix for the in-process case is for the graph's own mutation entry
 * points (`importExtractionResults`, `applyChangeSet`) to evict this entry, which
 * is a change in those modules, not this one.
 *
 * When `graphDbPath` is supplied and no in-memory index is cached, tries to
 * load the artifact written at refresh before falling back to {@link buildResolveIndex}.
 */
export const getResolveIndex = async (
  store: GraphStore,
  options?: GetResolveIndexOptions,
): Promise<ResolveIndex> => {
  const cached = cache.get(store);
  if (cached !== undefined) {
    const [countRow] = await runRows(store, NODE_COUNT_SQL, []);
    if (countRow !== undefined && Number(countRow['c']) === cached.nodeCount) {
      return cached;
    }
  }
  if (options?.graphDbPath !== undefined) {
    const loaded = await tryLoadResolveIndexArtifact(options.graphDbPath, store);
    if (loaded !== null) {
      cache.set(store, loaded);
      return loaded;
    }
  }
  const built = await buildResolveIndex(store);
  cache.set(store, built);
  return built;
};

/**
 * Gather the candidate node indices for a query: the recall-safe union of
 * exact-token, synonym-expanded-token, bigram, and whole-normalized-name
 * buckets. `queryTokens` are the tokenized query terms; `normQuery` the whole
 * normalized query (for the stop-word-name / whole-name exact path).
 */
export const gatherCandidates = (
  index: ResolveIndex,
  queryTokens: readonly string[],
  normQuery: string,
): readonly number[] => {
  const out = new Set<number>();
  const add = (idxs: readonly number[] | undefined): void => {
    if (idxs !== undefined) for (const i of idxs) out.add(i);
  };
  for (const qt of queryTokens) {
    add(index.byToken.get(qt));
    for (const syn of expandSynonyms(qt)) add(index.byToken.get(syn));
    for (const bg of charBigrams(qt)) add(index.byBigram.get(bg));
    add(index.bySortedChars.get(sortedChars(qt)));
  }
  if (normQuery.length >= 2) add(index.byNormName.get(normQuery));
  return [...out];
};
