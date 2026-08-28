/**
 * Handler for the `sfi.org_card` MCP tool — serve the refresh-time org card
 * (P13-CARD-tool): the ≤16 KB orientation snapshot an AI consumer loads
 * BEFORE its first question.
 *
 * READ-ONLY CACHE READ: the card is rendered once per refresh
 * (`meta/org-card.json`, beside `docs/org-card.md`) by the refresh hook —
 * this tool never recomputes it, so it costs one small file read instead of
 * the dozens of graph queries the assembly ran. A vault refreshed by an older
 * product version has no card yet; that is an honest `available: false` with
 * the refresh remedy, never an error and never a silently regenerated card
 * (a regenerated card would carry a render-time stamp that contradicts the
 * refresh-time provenance the card promises).
 *
 * CARD-CENSUS-RECONCILIATION: serving a cache verbatim inherits the cache's
 * blind spots. The card's per-type census is rendered at refresh time from the
 * manifest's `components` map — an ALLOW-LIST that goes stale the moment a new
 * modelled family is minted into the graph without being registered there. The
 * symptom seen on a real vault: a family whose nodes are in the graph, whose
 * XML is in the retrieved source, and which `sfi.list_components` enumerates
 * correctly, has NO row on the card, is silently missing from
 * `totals.components`, and appears in NONE of `coverage.partialTypes` /
 * `notModeledTypes` / `erroredTypes`. The card is the orientation surface the
 * product's own guidance tells a host to warm FIRST, so a missing row reads as
 * "this org has none" — a confident zero over real, retrieved components.
 *
 * This handler still refuses to re-render the card (that would forge the
 * refresh-time provenance). Instead it RECONCILES the served census against the
 * graph it is handed beside the card and emits {@link CardCensusReconciliation}:
 * the types the card omits, the counts it disagrees with, the rows it carries
 * that the graph does NOT back, the rows whose count is unreadable, and both
 * totals. When the reconciliation cannot run — no census on the card, or a
 * failed graph query — it reports `checked: false` with NULL lists, never an
 * empty list that a machine consumer would read as a checked-and-clean census.
 *
 * SYMMETRY IS PART OF THE GUARANTEE: an allow-list can rot in BOTH directions.
 * The real vault showed the drop direction (graph family with no card row), but
 * a renamed graph type, a family registered in the census and later dropped
 * from the graph, or a re-refresh that shrinks the graph all leave a card row
 * with NO nodes behind it — a confident NON-zero over nothing. A comparison
 * that only walks the graph would certify that card as clean, so the walk runs
 * in both directions AND the card's own `totals.components` must close before
 * any "every count matches" is spoken. A certification the code did not earn is
 * the same defect as the omission it was added to disclose.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';

/**
 * coverage-aware-zero (CR): the legacy-automation families the card's
 * automation counts summarize. When the manifest reports either was NOT
 * retrieved, an automation count of 0 on the card is "not retrieved,
 * re-refresh" — never a proven "no legacy automation".
 */
const CARD_AUTOMATION_COVERAGE = ['WorkflowRule', 'ApprovalProcess'] as const;

/** One family the graph holds and the card's per-type census omits ENTIRELY. */
export interface CardCensusMissingType {
  /** Graph node type with no row at all in the card's `componentCounts`. */
  readonly type: string;
  /** Exact `COUNT(*)` of that type in the graph. */
  readonly graphCount: number;
}

/** One family whose card count disagrees with the graph's exact count. */
export interface CardCensusMiscountedType {
  readonly type: string;
  /** What the card's `componentCounts` claims. */
  readonly cardCount: number;
  /** Exact `COUNT(*)` of that type in the graph. */
  readonly graphCount: number;
}

/**
 * One family the card's census lists that the graph holds NO node of. The card
 * over-registers: a count read off that row is a non-zero over nothing.
 */
export interface CardCensusExtraType {
  /** Type with a card row and zero nodes in the graph. */
  readonly type: string;
  /** What the card's `componentCounts` claims for it. */
  readonly cardCount: number;
}

/**
 * The served card's census measured against the graph, in BOTH directions.
 * ALWAYS emitted when a card is served, so a consumer can never silently
 * inherit a stale allow-list — whether it dropped a family or invented one.
 *
 * `checked: false` means the comparison did NOT run; every list is then `null`
 * rather than `[]`, because an empty list here would be indistinguishable from
 * "compared, nothing missing" — the exact confusion this block exists to end.
 */
export interface CardCensusReconciliation {
  /** True only when the card carried a census AND the graph census succeeded. */
  readonly checked: boolean;
  /** Why the comparison could not run. Absent when `checked` is true. */
  readonly unavailableReason?: string;
  /**
   * TYPED ABSENCE MARKER, and the reason this key exists rather than only
   * `message`.
   *
   * Every list below is `readonly T[] | null` — `null` for "did not run",
   * `[]` for "ran, found none" — which is the right shape and was NOT enough.
   * The integration honesty gate reads a payload the way a HOST does, and a
   * host looking at `typesMiscountedOnCard: []` cannot see the `checked: true`
   * that gives it meaning unless the payload says so in the vocabulary every
   * other tool uses. `boundaries[]` is that vocabulary. Prose in `message` is
   * for a human; this is for the machine that decides whether an empty list is
   * a clean bill of health.
   */
  readonly boundaries: readonly string[];
  /** Types in the graph with NO row on the card. `null` when not checked. */
  readonly typesMissingFromCard: readonly CardCensusMissingType[] | null;
  /** Types whose card count differs from the graph. `null` when not checked. */
  readonly typesMiscountedOnCard: readonly CardCensusMiscountedType[] | null;
  /**
   * Types with a card row the graph holds no node of — the MIRROR of
   * `typesMissingFromCard`. `null` when not checked. Without this list a card
   * that over-registers a family would pass the reconciliation as clean.
   */
  readonly typesOnCardNotInGraph: readonly CardCensusExtraType[] | null;
  /**
   * Types whose card row EXISTS but whose count is not a finite number, so it
   * could be neither confirmed nor refuted. Kept apart from
   * `typesMissingFromCard` because "no row" and "unreadable row" have different
   * remedies, and calling an unreadable row absent is a wrong diagnosis.
   * `null` when not checked.
   */
  readonly typesWithUnreadableCardCount: readonly string[] | null;
  /** The card's own `totals.components`; `null` when the card omits it. */
  readonly cardTotalComponents: number | null;
  /** Exact node count in the graph; `null` when the census query failed. */
  readonly graphTotalComponents: number | null;
  /** `graphTotalComponents - cardTotalComponents`; `null` when either is null. */
  readonly unreconciledComponents: number | null;
  /** The card's own `totals.edges`; `null` when the card omits it. */
  readonly cardTotalEdges: number | null;
  /** Exact edge count in the graph; `null` when the census query failed. */
  readonly graphTotalEdges: number | null;
  /** The same verdict in prose, for a host that reads the answer aloud. */
  readonly message: string;
}

/** One row of the `GROUP BY type` census. */
interface TypeCensusRow {
  readonly type: unknown;
  readonly n: unknown;
}

/** The graph side of the reconciliation, or `null` when the query failed. */
interface GraphCensus {
  readonly byType: ReadonlyMap<string, number>;
  readonly totalNodes: number;
  readonly totalEdges: number;
}

/**
 * Exact per-type node census plus the edge total, in two aggregate queries.
 * Mirrors the raw-connection `GROUP BY` idiom already used by
 * `doc-coverage-report` / `generate-architecture-overview`; a `GROUP BY` is the
 * only way to DISCOVER a type the card never named (a per-type
 * `countNodesByType` loop can only re-check the allow-list that is already
 * wrong). Returns `null` on any failure so the caller reports NOT CHECKED.
 */
const readGraphCensus = async (ctx: Context): Promise<GraphCensus | null> => {
  try {
    const typeReader = await ctx.graph.connection.runAndReadAll(
      'SELECT type, count(*)::INT AS n FROM nodes GROUP BY type',
    );
    const byType = new Map<string, number>();
    let totalNodes = 0;
    for (const row of typeReader.getRowObjectsJS() as unknown as readonly TypeCensusRow[]) {
      const n = Number(row.n);
      if (!Number.isFinite(n)) continue;
      byType.set(String(row.type), n);
      totalNodes += n;
    }
    const edgeReader = await ctx.graph.connection.runAndReadAll(
      'SELECT count(*)::INT AS n FROM edges',
    );
    const edgeRows = edgeReader.getRowObjectsJS() as unknown as readonly TypeCensusRow[];
    const edgeTotal = Number(edgeRows[0]?.n);
    return {
      byType,
      totalNodes,
      totalEdges: Number.isFinite(edgeTotal) ? edgeTotal : 0,
    };
  } catch {
    return null;
  }
};

/** The card's census split into rows we can compare and rows we cannot. */
interface CardCounts {
  /** Rows carrying a finite numeric count. */
  readonly counts: ReadonlyMap<string, number>;
  /**
   * Rows that EXIST on the card but whose value is not a finite number. These
   * are deliberately NOT folded into `counts` (a guessed count would be a
   * fabricated comparison) and NOT dropped either (dropping them made the type
   * look like it had no row at all, which is the wrong diagnosis and points at
   * the wrong remedy).
   */
  readonly unreadable: readonly string[];
}

/**
 * The card's `componentCounts`, or `null` when the card does not carry one.
 * R1: a MISSING property means the card was rendered by a build that never
 * wrote a census — it is not an empty census, and must not be read as one.
 */
const readCardCounts = (card: Readonly<Record<string, unknown>>): CardCounts | null => {
  const raw = card['componentCounts'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const counts = new Map<string, number>();
  const unreadable: string[] = [];
  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts.set(type, value);
    else unreadable.push(type);
  }
  unreadable.sort((a, b) => a.localeCompare(b));
  return { counts, unreadable };
};

/** One numeric field out of the card's `totals` block, or `null` when absent. */
const readCardTotal = (
  card: Readonly<Record<string, unknown>>,
  key: 'components' | 'edges',
): number | null => {
  const totals = card['totals'];
  if (totals === null || typeof totals !== 'object' || Array.isArray(totals)) return null;
  const value = (totals as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Shared tail: what a reader should do instead of trusting a missing row. */
const CENSUS_REMEDY =
  'Do not read the ABSENCE of a type row on this card as "this org has none", and do not read the PRESENCE of one as proof the family exists — call `sfi.list_components` for the type before answering with either a zero or a count, and re-run `sfi refresh --no-pull` to re-render the card.';

/** `A (n), B (n)` — bounded by the number of node types, so safe to inline. */
const describeTypes = (rows: readonly { type: string; graphCount: number }[]): string =>
  rows.map((r) => `${r.type} (${r.graphCount})`).join(', ');

/**
 * Compare the served card's census against the graph. Never throws; a failure
 * on either side degrades to `checked: false` with null lists.
 */
const reconcileCardCensus = async (
  ctx: Context,
  card: Readonly<Record<string, unknown>>,
): Promise<CardCensusReconciliation> => {
  const cardTotalComponents = readCardTotal(card, 'components');
  const cardTotalEdges = readCardTotal(card, 'edges');
  const graph = await readGraphCensus(ctx);
  const parsedCounts = readCardCounts(card);
  if (graph === null || parsedCounts === null) {
    const reason =
      graph === null
        ? 'the graph census query failed'
        : 'this card carries no `componentCounts` block (rendered by a build that predates the per-type census)';
    return {
      checked: false,
      boundaries: [
        'The card census was NOT reconciled against the graph on this call, so every list below is `null` rather than empty — read none of them as "checked, nothing wrong".',
      ],
      unavailableReason: reason,
      typesMissingFromCard: null,
      typesMiscountedOnCard: null,
      typesOnCardNotInGraph: null,
      typesWithUnreadableCardCount: null,
      cardTotalComponents,
      graphTotalComponents: graph === null ? null : graph.totalNodes,
      unreconciledComponents: null,
      cardTotalEdges,
      graphTotalEdges: graph === null ? null : graph.totalEdges,
      message: `The card's per-type census could NOT be reconciled against the graph (${reason}), so this response cannot tell you whether the card lists every family the vault holds. ${CENSUS_REMEDY}`,
    };
  }
  const cardCounts = parsedCounts.counts;
  const unreadable = parsedCounts.unreadable;
  const unreadableSet = new Set(unreadable);
  const missing: CardCensusMissingType[] = [];
  const miscounted: CardCensusMiscountedType[] = [];
  const extra: CardCensusExtraType[] = [];
  const byDescendingCount = (a: readonly [string, number], b: readonly [string, number]): number =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  // Direction 1 — graph → card: the families the card's allow-list DROPPED.
  for (const [type, graphCount] of [...graph.byType].sort(byDescendingCount)) {
    // A row that exists but cannot be read is reported as unreadable, never as
    // absent: "add the row" and "fix the row's value" are different remedies.
    if (unreadableSet.has(type)) continue;
    const cardCount = cardCounts.get(type);
    if (cardCount === undefined) missing.push({ type, graphCount });
    else if (cardCount !== graphCount) miscounted.push({ type, cardCount, graphCount });
  }
  // Direction 2 — card → graph: the families the card lists that the graph does
  // NOT back. Without this loop an over-registering card is certified clean.
  for (const [type, cardCount] of [...cardCounts].sort(byDescendingCount)) {
    if (!graph.byType.has(type)) extra.push({ type, cardCount });
  }
  const unreconciledComponents =
    cardTotalComponents === null ? null : graph.totalNodes - cardTotalComponents;
  // The card's own headline total is a THIRD claim, independent of the per-type
  // rows: it can be wrong while every row is right. A clean bill that ignores it
  // would be contradicted by `unreconciledComponents` in the same object.
  const totalsClose = unreconciledComponents === null || unreconciledComponents === 0;
  const rowsAgree =
    missing.length === 0 && miscounted.length === 0 && extra.length === 0 && unreadable.length === 0;
  const edgeClause =
    cardTotalEdges === null
      ? `The card states no edge total; the graph holds ${graph.totalEdges} edges.`
      : cardTotalEdges === graph.totalEdges
        ? `The edge total matches the graph (${graph.totalEdges}).`
        : `The card's edge total (${cardTotalEdges}) also disagrees with the graph (${graph.totalEdges}).`;
  const totalsClause =
    unreconciledComponents === null
      ? 'The card states no component total.'
      : unreconciledComponents === 0
        ? `The card's own component total (${cardTotalComponents}) agrees with the graph (${graph.totalNodes}).`
        : `The card's own \`totals.components\` (${cardTotalComponents}) does NOT close against the ${graph.totalNodes} components the graph holds — it is off by ${Math.abs(unreconciledComponents)}, so it must not be quoted as the size of this org.`;
  if (rowsAgree && totalsClose) {
    return {
      checked: true,
      boundaries: [
        'The card census WAS reconciled against the graph in both directions, so the empty lists below are CHECKED zeros, not unchecked ones.',
        'A type absent from BOTH the card and the graph is absent from the VAULT, which is not the same as absent from the org — read `coverage.partialTypes` / `notModeledTypes` for what was never retrieved.',
      ],
      typesMissingFromCard: [],
      typesMiscountedOnCard: [],
      typesOnCardNotInGraph: [],
      typesWithUnreadableCardCount: [],
      cardTotalComponents,
      graphTotalComponents: graph.totalNodes,
      unreconciledComponents,
      cardTotalEdges,
      graphTotalEdges: graph.totalEdges,
      message: `The card's per-type census was reconciled against the graph in BOTH directions: all ${graph.byType.size} node types present in the vault have a readable card row, every count matches, and the card lists no type the graph holds no node of (${graph.totalNodes} components). ${totalsClause} ${edgeClause} A type absent from BOTH is absent from the VAULT — which is not the same as absent from the org; read \`coverage.partialTypes\` / \`notModeledTypes\` for what was never retrieved.`,
    };
  }
  const parts: string[] = [
    rowsAgree
      ? `The card's per-type rows all match the graph type-for-type, but the card's census still does NOT reconcile.`
      : `The card's per-type census is INCOMPLETE against the graph it was served beside: the card carries ${
          cardCounts.size + unreadable.length
        } type rows (${cardCounts.size} with a readable count), the graph holds ${
          graph.byType.size
        } types totalling ${graph.totalNodes} components.`,
  ];
  if (missing.length > 0) {
    parts.push(
      `Present in the graph with NO row on the card: ${describeTypes(missing)}. These are modelled components the card's census dropped — they are NOT disclosed in \`coverage.partialTypes\`, \`notModeledTypes\`, or \`erroredTypes\` either.`,
    );
  }
  if (miscounted.length > 0) {
    parts.push(
      `Counted differently by card and graph: ${miscounted
        .map((r) => `${r.type} (card ${r.cardCount}, graph ${r.graphCount})`)
        .join(', ')}.`,
    );
  }
  if (extra.length > 0) {
    parts.push(
      `Listed on the card with NO node of that type in the graph: ${extra
        .map((r) => `${r.type} (card ${r.cardCount})`)
        .join(
          ', ',
        )}. The card OVER-registers here: quoting one of those counts would be a confident non-zero over a family the vault holds nothing of.`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `Rows present on the card whose count is UNREADABLE (not a finite number), so they could be neither confirmed nor refuted: ${unreadable.join(
        ', ',
      )}. The row EXISTS — this is a malformed value, not a dropped family.`,
    );
  }
  parts.push(totalsClause, edgeClause, CENSUS_REMEDY);
  return {
    checked: true,
    boundaries: [
      'The card census WAS reconciled against the graph and DISAGREED — the lists below name every discrepancy, and an empty one among them is a checked zero for that axis.',
      CENSUS_REMEDY,
    ],
    typesMissingFromCard: missing,
    typesMiscountedOnCard: miscounted,
    typesOnCardNotInGraph: extra,
    typesWithUnreadableCardCount: unreadable,
    cardTotalComponents,
    graphTotalComponents: graph.totalNodes,
    unreconciledComponents,
    cardTotalEdges,
    graphTotalEdges: graph.totalEdges,
    message: parts.join(' '),
  };
};

/** Zod schema for `sfi.org_card` — no inputs; the card is one per vault. */
export const orgCardInputSchema = z.object({});

export type OrgCardToolInput = z.infer<typeof orgCardInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OrgCardToolOutput {
  /** False when the vault predates the card-rendering refresh hook. */
  readonly available: boolean;
  /** The parsed `meta/org-card.json` (shape rendered at refresh), when available. */
  readonly card?: Readonly<Record<string, unknown>>;
  /** Honest next step when the card is absent. */
  readonly remedy?: string;
  /**
   * coverage-aware-zero (CR): present when the card is served but the manifest
   * reports the legacy-automation families (WorkflowRule / ApprovalProcess) the
   * card's automation counts summarize were NOT retrieved. A 0 automation count
   * under this caveat is "not retrieved, re-refresh", NOT a proven "none".
   * Absent on a legacy (no-coverage) vault and on a confirmed-clean retrieve.
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * CARD-CENSUS-RECONCILIATION: the served card's `componentCounts` measured
   * against the graph in BOTH directions (families the card dropped, and rows
   * the card carries that the graph does not back), plus whether the card's own
   * `totals.components` closes. ALWAYS present when `available` is true — a card
   * whose census could not be reconciled says so (`checked: false`) rather than
   * going quiet. Absent only when there is no card to reconcile.
   */
  readonly censusReconciliation?: CardCensusReconciliation;
}

const ABSENT_REMEDY =
  'No org card in this vault yet — it is rendered at refresh time (every full `sfi refresh`, including `sfi refresh --no-pull` on existing source). Run `/sfi-refresh` or `sfi refresh --no-pull` with the current CLI, then call sfi.org_card again. Vaults last refreshed before v0.1.9 never wrote meta/org-card.json.';

/**
 * The `sfi.org_card` MCP tool. Serves the cached refresh-time org card.
 *
 * @example
 *   const r = await orgCardHandler(ctx, {});
 *   if (r.ok && r.value.data.available) orient(r.value.data.card);
 */
export const orgCardHandler = async (
  ctx: Context,
  _input: OrgCardToolInput,
): Promise<Result<McpResponse<OrgCardToolOutput>, McpError>> => {
  const cardPath = join(ctx.vaultRoot, 'meta', 'org-card.json');
  let raw: string;
  try {
    raw = await readFile(cardPath, 'utf8');
  } catch {
    return ok({
      data: { available: false, remedy: ABSENT_REMEDY },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }
  let card: Readonly<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    card = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return err({
      kind: 'internal',
      message: `meta/org-card.json is unreadable (corrupt JSON) — re-run \`sfi refresh --no-pull\` to regenerate it.`,
    });
  }
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    CARD_AUTOMATION_COVERAGE,
    'The card automation counts',
  );
  const censusReconciliation = await reconcileCardCensus(ctx, card);
  return ok({
    data: {
      available: true,
      card,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      censusReconciliation,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
