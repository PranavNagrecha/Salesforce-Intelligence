/**
 * Handler for the `sfi.find_field_anywhere` MCP tool.
 *
 * The v2.2 universal "find this field everywhere it's touched" surface —
 * the canonical Q86-style discovery question for a single field id.
 * Composes incoming edges of every code/declarative kind that
 * references a CustomField, groups them by the referrer's
 * `ComponentType`, and surfaces a structured cross-component-type
 * inventory: Apex reads/writes, Apex calls (when the field is an Apex
 * class), Flow record-lookup/create/update references, Layout
 * placements, formula references, ValidationRule references,
 * SharingRule criteria references, and any other declarative edge that
 * exists in the graph.
 *
 * **Composition recipe:** one
 * `listEdges(fieldId, { direction: 'in' })` call retrieves every
 * incoming edge regardless of type; the handler then walks each edge's
 * `fromId`, resolves the referrer to a `Node`, and emits one
 * `FieldReference` per (referrer, edgeType) pair. Sparse-graph misses
 * (the referrer node is not in the graph) are dropped silently.
 *
 * **Grouping axis:** results are bucketed by the referrer's
 * `ComponentType` — `ApexClass`, `ApexTrigger`, `Flow`, `Layout`,
 * `ValidationRule`, `SharingRule`, `WorkflowRule`, etc. The grouping is
 * the universal-search ergonomic: the consumer asks "where is this
 * field used?" and wants the answer split by KIND of usage, not by
 * individual referrer.
 *
 * **Edge-type axis within a group:** within each ComponentType bucket
 * the references retain their `edgeType` so a consumer rendering the
 * group can distinguish reads from writes (Apex `readsFrom` vs.
 * `writesTo`) or formula references from metadata references
 * (`references` edge with `source: 'formula-tokenizer'` vs.
 * `source: 'metadata-dependency'`).
 *
 * **v2.2 honesty axis:** the v0.3 / v1.4 / v2.1 string-stripping
 * discipline means dynamic SOQL strings, reflective field access
 * (`obj.get('FieldName')`), and managed-package code are INVISIBLE to
 * the graph edges this tool walks. The `boundaries` array surfaces the
 * method + invisibility disclosures on EVERY successful response,
 * including (especially) a zero — see GRAPH_EDGE_WALK_DISCLOSURE and
 * ZERO_IS_A_GRAPH_ZERO for what those two sentences used to get wrong.
 * NOTE THAT THIS TOOL READS NO FILE: it does not pattern-match Apex,
 * Flow XML or metadata XML at call time, and the boundary text no
 * longer claims it does.
 *
 * **Unresolved-id axis:** the edge walk is keyed on the CANONICAL field
 * id, so every edge an extractor minted against a different spelling of
 * the same field (the dotted prefix of a ReportType column's `<field>`
 * element, a case-variant object name, an object the refresh never retrieved) is
 * invisible to it and the answer reads as a checked zero. Those edges
 * are recovered into the always-present typed
 * `unresolvedApiNameMatches` section via the graph's own dangling-target
 * anti-join, and are deliberately NEVER folded into `totalCount` — an
 * api-name match is a lead, not a proven usage.
 *
 * Implementation notes:
 *   - The CustomField id is `targetId` OR its alias `fieldId` (parity with
 *     the field-tool family); exactly one is required and must start with
 *     `CustomField:`. A missing id or non-CustomField prefix surfaces as
 *     `invalid-query` at the handler boundary.
 *   - EXISTENCE GATE: the prefix check alone let a typo, a WRONG-CASE id, and a
 *     never-retrieved field all return the same confident
 *     `{groups: [], totalCount: 0}` as a field that is genuinely referenced
 *     nowhere. An id that no node carries AND no edge references now surfaces
 *     as `component-not-found` with ranked `resolveSuggestions`
 *     (`fieldNotFoundError` + `phantomAwareNotFoundMessage` — the same pair the
 *     sibling field tools use). A PHANTOM id — referenced by real edges but
 *     whose own definition was never retrieved — still ANSWERS (those
 *     references are true) and carries a boundary saying the definition is
 *     absent and the folded report/dashboard flags could not be read.
 *   - The sort within each group is deterministic — `componentId ASC`,
 *     then `edgeType ASC`. The grouped output is sorted alphabetically
 *     by component-type label so the response is reproducible across
 *     runs.
 *   - `limit` caps the TOTAL match count across all groups, not the
 *     per-group count. The slice is applied AFTER the per-group sort
 *     so truncation is stable.
 *   - `confidence` on each reference is the edge's stored confidence
 *     (`declared` for layout / formula / parentOf-declared edges,
 *     `heuristic` for apex-scanner / lwc-scanner / flow-extractor
 *     edges). The tool does not re-classify; it surfaces what the
 *     extractor stored.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  EdgeType,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
  PageCursorToken,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  danglingTargetIdsMatching,
  getNodeById,
  listEdges,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { fieldNotFoundError } from './field-not-found-suggest.js';
import {
  argsFingerprint,
  decodeCursor,
  encodeCursor,
  PAGE_CURSOR_VERSION,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsage,
} from './report-dashboard-usage.js';
import { toolLocalPayloadBudgetBytes } from './response-budget.js';

/**
 * Floor for the designated section's page budget.
 *
 * The page budget itself is DERIVED from `toolLocalPayloadBudgetBytes()` at
 * call time (see the call site) rather than declared as a hard-coded sibling of
 * it. It used to be a literal `38_000`, which is a hand-maintained neighbour of
 * the global budget's effective ceiling — the exact drift
 * `response-budget.ts` was written to end. This floor only bites when
 * `SFI_MAX_RESPONSE_BYTES` is set so low that the derived budget would leave no
 * room for a page at all.
 */
const DESIGNATED_SECTION_FLOOR_BYTES = 2_000;

/** Canonical CustomField prefix. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';
/** Inclusive upper bound on `limit`. */
const FIND_FIELD_ANYWHERE_MAX_LIMIT = 500;
/** Default `limit`. */
const FIND_FIELD_ANYWHERE_DEFAULT_LIMIT = 200;
/**
 * How many of the matching unresolved ids are WALKED to ENUMERATE referrers.
 *
 * This caps the ENUMERATION ONLY. It does not cap `referenceCount` or
 * `byComponentType`: those come from {@link aggregateUnresolvedReferrers}, one
 * SQL aggregate over EVERY matching id, so they are exact at any number of ids.
 *
 * WHAT THIS DOC USED TO CLAIM, AND WHY IT WAS FALSE. It said "the COUNT
 * reported is the true pre-cap total ... so the cap can never read as a smaller
 * blind spot than the vault actually has". `referenceCount` was `referrers
 * .length` — a tally over the WALKED subset — so the sentence was false for
 * every api name carried by more than {@link UNRESOLVED_ID_SCAN_CAP} unresolved
 * ids. Measured on a real vault: the commonest such api name is carried by 226
 * unresolved ids holding 568 referring edges, and the tool published
 * `referenceCount: 97` under prose certifying it as the true total — a 5.9x
 * understatement, in a sentence a host reads aloud. Five api names on that
 * vault exceed the cap, covering 133 real CustomField nodes.
 *
 * Why the walk stays capped even though the count no longer is: the walk costs
 * one `listEdges` plus one `getNodeById` PER EDGE. Measured on that vault, the
 * uncapped walk for those 226 ids took 4 234 ms; the aggregate that now
 * produces the same 568 took 62 ms. The expensive pass buys only ROWS, and rows
 * are what the byte budget makes us give back first anyway.
 */
const UNRESOLVED_ID_SCAN_CAP = 50;
/** How many resolved referrers the unresolved section emits (counts stay true). */
const UNRESOLVED_REFERRER_CAP = 50;
/**
 * Max ids bound into one `IN (...)` of the count aggregate. The aggregate is
 * chunked and SUMMED, so the exactness of the total does not depend on how many
 * ids match — no chunk boundary is a silent cap.
 */
const UNRESOLVED_ID_AGGREGATE_CHUNK = 500;
/**
 * Hard byte ceiling for the serialised unresolved section. Without it an
 * always-present new section could push the widest field's response past the
 * ceiling the global guard enforces and turn a working answer into a truncated
 * or oversize one. The section shrinks its referrer list (then its id list)
 * until it fits, flips `truncated`, and NEVER lowers `referenceCount` /
 * `idsTotal` / `byComponentType` — the shrink changes what is ENUMERATED, never
 * what is CLAIMED.
 */
const UNRESOLVED_SECTION_BYTE_CAP = 9_000;

/**
 * Verbatim honesty disclosures echoed in the response's `boundaries`.
 *
 * WHAT THE FIRST SENTENCE USED TO SAY, AND WHY IT WAS THE DEFECT. Until this
 * change it read "the search uses pattern-matching over Apex source, Flow XML,
 * and metadata XML". This handler runs NO text pass of any kind — it is one
 * `listEdges(direction: 'in')` call plus node lookups. A host that read the old
 * sentence aloud told the admin that the metadata XML HAD been searched, which
 * is how a `totalCount` covering only permission grants got reported as a
 * verified "used by nothing else" for a field whose references sit in metadata
 * XML in the very vault being read. The sentence now names the method the
 * handler actually uses and points at the tools that DO read files.
 */
const GRAPH_EDGE_WALK_DISCLOSURE =
  "this answer is an EDGE WALK over the already-extracted graph. No file is opened and no text pass runs at call time — a referrer appears here only if an extractor already resolved it to this EXACT field id, so this list is a statement about the GRAPH, not a verified statement about the org. Dynamic SOQL (`Database.query('SELECT...')`) built from strings, reflective field access (`obj.get('FieldName')`), and custom utility methods that wrap the operation are never resolved to an edge and are invisible here. To search the vaulted FILES themselves use `sfi.search_apex_source` / `sfi.search_flow_metadata`, or grep `{vaultRoot}/source/` directly.";
const MANAGED_PACKAGE_DISCLOSURE =
  'managed-package Apex source is not indexed, so no edge is ever minted from it. If the operation lives inside a managed-package class, nothing in this list will show it.';
/**
 * Pushed when the edge walk resolved NOTHING. The zero is the answer that most
 * needs the caveats and it used to be the answer that carried the FEWEST: the
 * two disclosures above were gated on `collected.length > 0`, so a field with no
 * resolved referrer returned a bare zero with only the report/dashboard caveat
 * attached. That is the certified zero this tool exists not to produce.
 */
const ZERO_IS_A_GRAPH_ZERO =
  '`totalCount: 0` means NO EXTRACTED EDGE LANDS ON THIS EXACT ID. It is NOT a verified "this field is used nowhere". An extractor that minted its reference against a DIFFERENT id — a relationship alias in place of the object api name, a case-variant spelling, an object this refresh never retrieved — produces exactly this zero while the reference is real and sitting in the vault XML. Read `unresolvedApiNameMatches` below before acting on it, and confirm with a text search over `{vaultRoot}/source/` before deleting anything.';
/**
 * PHANTOM target: the id is referenced by real edges but no node carries it, so
 * the field's own definition was never retrieved. The reference list is still
 * true — refusing would throw away a real answer — but the folded
 * report/dashboard flags live on the ABSENT node and cannot be read at all, so
 * a plain "no report usage" caveat here would be a second confident zero.
 */
const phantomTargetDisclosure = (id: string): string =>
  `\`${id}\` is referenced by the component(s) listed above, but its OWN CustomField definition was never retrieved into this vault — typically a managed-package field, an uncustomized standard field the Metadata API does not emit, or one outside the retrieve scope. Treat the reference list as what the graph holds ABOUT the id, not as a complete picture of the field; the folded \`usedInReport\` / \`usedInDashboard\` flags live on the missing node and could NOT be read, so report/dashboard usage is UNKNOWN here rather than absent.`;

/**
 * Zod schema for the `sfi.find_field_anywhere` tool input.
 *
 *   - `targetId` (or its alias `fieldId`): exactly one required, a
 *     non-empty string starting with `CustomField:`; a missing id or a
 *     non-matching prefix surfaces as `invalid-query` at the handler
 *     boundary.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 200.
 *   - `componentTypes`: optional array filter — narrows the returned
 *     references to a subset of ComponentTypes (e.g., only Apex
 *     classes, only Flows). Omitted means "all".
 */
export const findFieldAnywhereInputSchema = z.object({
  // `targetId` is the canonical param. `fieldId` is accepted as an ALIAS for
  // parity with the rest of the field-tool family (field_360, field_access_audit,
  // field_lineage, safe_to_delete_field, … all take `fieldId`), so an agent that
  // learned `fieldId` there doesn't hit a confusing `targetId: Required`. Exactly
  // one of the two is required (enforced in the handler).
  targetId: z.string().min(1).optional(),
  fieldId: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(FIND_FIELD_ANYWHERE_MAX_LIMIT)
    .optional(),
  componentTypes: z.array(z.string().min(1)).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which
  // ComponentType section it advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type FindFieldAnywhereInput = z.infer<
  typeof findFieldAnywhereInputSchema
>;

/** One reference in the response. */
export interface FieldReference {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly edgeType: EdgeType;
  readonly source: string;
  readonly confidence: ConfidenceLevel;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A grouped bucket of references sharing one ComponentType. */
export interface ReferenceGroup {
  readonly componentType: ComponentType;
  readonly references: readonly FieldReference[];
  readonly count: number;
}

/**
 * References the graph HOLDS that name a field with THIS field's api name under
 * an object id that resolves to NO node in this vault.
 *
 * ## The measured defect this exists for
 *
 * An extractor does not always know the object api name that owns a field it
 * saw. `enterprise-metadata.ts`'s column sweep mints `CustomField:{token}` for
 * any `<field>` value CONTAINING a dot, so a ReportType column written as a
 * relationship path becomes `CustomField:{RelationshipPath}.{Field}` rather
 * than `CustomField:{Object}.{Field}`. The edge is real, its referrer is real,
 * and its target id resolves to nothing — so an edge walk keyed on the
 * CANONICAL id sees none of it and returns a `totalCount` covering only the
 * permission grants. On the vault this was measured against, 91.6% of that
 * family's edges had a target no node carries, and the tool the honest sibling
 * tools REDIRECT to for those surfaces answered zero.
 *
 * IT IS THE `<field>` PREFIX, NOT THE SECTION'S `<table>`. Ground truth on that
 * vault: of 1 793 dotted `<field>` values across the ReportType corpus, 1 793
 * have a prefix that DIFFERS from the sibling `<table>` element — zero match it.
 * A reader sent to `<table>` opens the wrong element.
 *
 * ## WHAT THIS SECTION CANNOT RECOVER, AND WHY
 *
 * The far bigger half of the same gap is upstream and OUT OF THIS FILE'S REACH.
 * `extractReportType` passes no parent object and a ReportType XML has no
 * `<reportType>` element, so `inferReportObjectApiName` returns null and a BARE
 * `<field>Some_Field__c</field>` mints NO EDGE AT ALL — there is nothing
 * dangling for this anti-join to find. Ground truth on that vault: 33 203 bare
 * `<field>` values versus 1 793 dotted ones. The finding that prompted this
 * section named 48 report types using the BARE form; this section recovers
 * none of them, and cannot. See `needsOrchestrator` — the fix is
 * `parentFromXmlElement: 'baseObject'` (or per-section `<table>` scoping) in
 * `packages/extractors/src/enterprise-metadata.ts`.
 *
 * ## Why it is a SEPARATE typed section and never folded into `totalCount`
 *
 * The match is on api name only. `CustomField:Other_Obj__c.Status__c` may be
 * this field reached through a relationship alias, or a genuinely different
 * field that happens to share a name. THE VAULT CANNOT TELL THEM APART, so
 * counting them as usages would trade a false zero for a false positive. They
 * are published as leads to check, with the ambiguity stated in `note`.
 *
 * ## Absence here is a CHECKED absence
 *
 * The section is emitted on EVERY successful response. `referenceCount: 0` with
 * `scanned: true` means the anti-join ran and found none; it is never the
 * silence of a section that was skipped.
 */
export interface UnresolvedApiNameMatches {
  /** The field api name the scan matched on (the id's text after its first dot). */
  readonly fieldApiName: string;
  /** True on every successful response — the scan is unconditional. */
  readonly scanned: boolean;
  /**
   * Distinct unresolved `CustomField:` ids carrying this api name, across the
   * WHOLE vault. Never capped.
   */
  readonly idsTotal: number;
  /**
   * How many of those ids were walked to ENUMERATE `referrers`
   * ({@link UNRESOLVED_ID_SCAN_CAP}). `idsScanned < idsTotal` means the ROW
   * LIST is a sample — it does NOT mean the counts below are partial.
   */
  readonly idsScanned: number;
  /**
   * EXACT count of referring edges across ALL {@link idsTotal} ids, from one
   * SQL aggregate — not a tally of the walked subset, and not a floor. Honours
   * the `componentTypes` filter and excludes `parentOf`, exactly as
   * {@link referrers} does.
   */
  readonly referenceCount: number;
  /**
   * The unresolved ids, ASC — the walked slice, further shrunk to fit the byte
   * budget. A SAMPLE whenever `idsScanned < idsTotal` or `truncated` is true.
   */
  readonly unresolvedTargetIds: readonly ComponentId[];
  /**
   * Referrer rows from the walked ids, capped at
   * {@link UNRESOLVED_REFERRER_CAP} and shrunk further under byte pressure. A
   * SAMPLE of {@link referenceCount}, never a claim to be all of it.
   */
  readonly referrers: readonly FieldReference[];
  /**
   * EXACT referrer-ComponentType tally across ALL {@link idsTotal} ids, from
   * the same aggregate as {@link referenceCount}. Its values sum to
   * `referenceCount`; it is never a tally of the enumerated slice.
   */
  readonly byComponentType: Readonly<Record<string, number>>;
  /**
   * True when the ENUMERATED lists are a sample of what the counts describe —
   * because the id walk was capped, the referrer list was capped, or the byte
   * budget shrank either. Counts are unaffected.
   */
  readonly truncated: boolean;
  /** Prose a host will read aloud, stating what this is and what it is not. */
  readonly note: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindFieldAnywhereOutput {
  readonly targetId: ComponentId;
  readonly groups: readonly ReferenceGroup[];
  readonly totalCount: number;
  readonly byEdgeType: Readonly<Record<string, number>>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when truncated (the designated
   * ComponentType section overflowed `limit`/the byte budget). Echo it back as
   * `cursor` to resume; absent on a whole-fits page so the response is
   * byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated section; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which ComponentType section the cursor advances; truncation only. */
  readonly designatedList?: string;
  /** The non-paged ComponentType sections, with their full reference counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
  /**
   * Always present. Edges the graph holds against a DIFFERENT, unresolvable id
   * carrying this field's api name — the blind spot that made this tool's
   * zero look verified. Never folded into `groups` / `totalCount` / `byEdgeType`.
   */
  readonly unresolvedApiNameMatches: UnresolvedApiNameMatches;
  /**
   * The method that produced `groups`. A literal, so a machine consumer can
   * assert the answer is an edge walk rather than infer a text pass from prose.
   */
  readonly searchMethod: 'graph-edge-walk';
}

const isCustomField = (id: string): boolean =>
  id.startsWith(CUSTOM_FIELD_PREFIX);

/**
 * Resolve one incoming edge to a `FieldReference` by looking up the
 * referrer node and copying identity + edge metadata. Sparse-graph
 * misses (referrer node not present) return `null` and are dropped by
 * the caller — same tolerance as `find-formula-references` and
 * `find-apex-usages`.
 */
const resolveReference = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<FieldReference | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) return ok(null);
  return ok({
    componentId: node.id,
    componentType: node.type,
    apiName: node.apiName,
    edgeType: edge.edgeType,
    source: edge.source,
    confidence: edge.confidence,
    properties: edge.properties,
  });
};

/**
 * Deterministic comparator inside one ComponentType bucket:
 * `componentId ASC`, then `edgeType ASC`, then `source ASC`. The final `source`
 * tiebreak makes the order match the graph edge PK `(from_id, to_id, edge_type,
 * source)` exactly — UNIQUE — so an offset-based section cursor resume can
 * neither dup nor skip at a (componentId, edgeType) tie (two edges from one
 * referrer with the same edgeType but different `source`).
 */
const compareRefs = (a: FieldReference, b: FieldReference): number => {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * The field portion of a `CustomField:` id: everything after the FIRST dot that
 * follows the prefix. `CustomField:Contact.Owner.Name` -> `Owner.Name`, which is
 * the same split the graph's own ids use for a relationship-traversed column.
 * Returns `null` for an id with no dot (not a field id shape).
 */
const fieldApiNameOf = (id: string): string | null => {
  const body = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = body.indexOf('.');
  return dot === -1 || dot === body.length - 1 ? null : body.slice(dot + 1);
};

/**
 * EXACT referrer tally across EVERY matching unresolved id, in one aggregate
 * per chunk of {@link UNRESOLVED_ID_AGGREGATE_CHUNK} ids.
 *
 * This exists because the referrer WALK is capped and a count taken from the
 * walked subset is a lie the size of the tail. Measured on a real vault: the
 * commonest dangling field api name is carried by 226 unresolved ids holding
 * 568 referring edges; the 50-id walk saw 97. The aggregate returns 568 in
 * 62 ms — the walk needed 4 234 ms to reach the same number.
 *
 * Predicate parity with the walk is load-bearing, and is asserted by a test
 * that compares the two on the same fixture: `parentOf` is excluded (a field's
 * own parent object is not a referrer), the referrer node must EXIST (the walk
 * drops an unresolvable referrer via `resolveReference` returning `null`; the
 * `JOIN nodes` does the same), and `typeFilter` is applied. Any divergence
 * would put a count next to rows that disagree with it.
 */
const aggregateUnresolvedReferrers = async (
  ctx: Context,
  ids: readonly ComponentId[],
  typeFilter: ReadonlySet<string> | null,
): Promise<Result<Record<string, number>, string>> => {
  const tally: Record<string, number> = {};
  const types = typeFilter === null ? [] : [...typeFilter];
  if (typeFilter !== null && types.length === 0) return ok(tally);
  for (let i = 0; i < ids.length; i += UNRESOLVED_ID_AGGREGATE_CHUNK) {
    const chunk = ids.slice(i, i + UNRESOLVED_ID_AGGREGATE_CHUNK);
    const idPlaceholders = chunk.map(() => '?').join(',');
    const typeClause =
      types.length === 0 ? '' : ` AND n.type IN (${types.map(() => '?').join(',')})`;
    const sql = `SELECT n.type AS component_type, COUNT(*) AS c
         FROM edges e
         JOIN nodes n ON e.from_id = n.id
        WHERE e.to_id IN (${idPlaceholders})
          AND e.edge_type <> 'parentOf'${typeClause}
        GROUP BY n.type`;
    try {
      const reader = await ctx.graph.connection.runAndReadAll(sql, [
        ...chunk,
        ...types,
      ]);
      for (const row of reader.getRowObjectsJS()) {
        const t = String(row['component_type'] ?? '');
        tally[t] = (tally[t] ?? 0) + Number(row['c'] ?? 0);
      }
    } catch (e) {
      return err((e as Error).message);
    }
  }
  return ok(tally);
};

/**
 * Scan the graph for edges whose target is an UNRESOLVED `CustomField:` id
 * carrying the same field api name as `targetId`, and resolve their referrers.
 *
 * Adopts the graph's own anti-join (`danglingTargetIdsMatching`) rather than a
 * fourth local copy of "LEFT JOIN nodes ... IS NULL"; the substring pre-filter
 * is deliberately loose, so the EXACT api-name equality is re-applied here
 * (case-insensitively — Salesforce api names are case-insensitive and the vault
 * carries case-variant spellings).
 */
const scanUnresolvedApiNameMatches = async (
  ctx: Context,
  targetId: ComponentId,
  typeFilter: ReadonlySet<string> | null,
): Promise<Result<UnresolvedApiNameMatches, McpError>> => {
  const fieldApiName = fieldApiNameOf(targetId);
  const empty = (name: string, note: string): UnresolvedApiNameMatches => ({
    fieldApiName: name,
    scanned: true,
    idsTotal: 0,
    idsScanned: 0,
    referenceCount: 0,
    unresolvedTargetIds: [],
    referrers: [],
    byComponentType: {},
    truncated: false,
    note,
  });
  if (fieldApiName === null) {
    return ok(
      empty(
        '',
        'No field api name could be split out of this id, so the unresolved-id scan could not run. Treat a zero above as UNCHECKED for references minted against a different id.',
      ),
    );
  }

  const danglingResult = await danglingTargetIdsMatching(
    ctx.graph,
    `.${fieldApiName}`,
  );
  if (!danglingResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${danglingResult.error.message}`,
    });
  }
  const wanted = fieldApiName.toLowerCase();
  const matching = danglingResult.value
    .filter(
      (id) =>
        id.startsWith(CUSTOM_FIELD_PREFIX) &&
        id !== targetId &&
        (fieldApiNameOf(id) ?? '').toLowerCase() === wanted,
    )
    .slice()
    .sort((a2, b2) => (a2 < b2 ? -1 : a2 > b2 ? 1 : 0));

  if (matching.length === 0) {
    return ok(
      empty(
        fieldApiName,
        `Checked: no edge in this vault names an UNRESOLVABLE \`CustomField:*.${fieldApiName}\` id, so no reference to this field is hiding behind a relationship alias or a case-variant object spelling. This is a scanned zero, not a skipped section.`,
      ),
    );
  }

  // COUNTS come from ONE aggregate over EVERY matching id — never from the
  // walked slice below. The walked slice buys ROWS, and rows are the first
  // thing the byte budget takes back; a count taken from them understated a
  // real vault's blind spot 5.9x while calling itself a true total.
  const aggregated = await aggregateUnresolvedReferrers(ctx, matching, typeFilter);
  if (!aggregated.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${aggregated.error}` });
  }
  const byComponentType = aggregated.value;
  const referenceCount = Object.values(byComponentType).reduce((a2, b2) => a2 + b2, 0);

  const walked = matching.slice(0, UNRESOLVED_ID_SCAN_CAP);
  const referrers: FieldReference[] = [];
  for (const id of walked) {
    const edges = await listEdges(ctx.graph, id, { direction: 'in' });
    if (!edges.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edges.error.message}`,
      });
    }
    for (const edge of edges.value) {
      if (edge.edgeType === 'parentOf') continue;
      const resolved = await resolveReference(ctx, edge);
      if (!resolved.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${resolved.error}` });
      }
      if (resolved.value === null) continue;
      if (typeFilter !== null && !typeFilter.has(resolved.value.componentType)) {
        continue;
      }
      referrers.push(resolved.value);
    }
  }
  referrers.sort(compareRefs);
  // Fit the section to UNRESOLVED_SECTION_BYTE_CAP: drop enumerated referrers
  // first, then enumerated ids. Counts are computed above and never touched.
  let shownRefs = referrers.slice(0, UNRESOLVED_REFERRER_CAP);
  let shownIds: readonly ComponentId[] = walked;
  const sectionBytes = (): number =>
    Buffer.byteLength(JSON.stringify({ shownRefs, shownIds }), 'utf8');
  while (sectionBytes() > UNRESOLVED_SECTION_BYTE_CAP && shownRefs.length > 0) {
    shownRefs = shownRefs.slice(0, Math.max(0, Math.floor(shownRefs.length / 2)));
  }
  while (sectionBytes() > UNRESOLVED_SECTION_BYTE_CAP && shownIds.length > 1) {
    shownIds = shownIds.slice(0, Math.max(1, Math.floor(shownIds.length / 2)));
  }
  const truncated =
    matching.length > shownIds.length || referenceCount > shownRefs.length;
  const kinds = Object.entries(byComponentType)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  return ok({
    fieldApiName,
    scanned: true,
    idsTotal: matching.length,
    idsScanned: walked.length,
    referenceCount,
    unresolvedTargetIds: shownIds,
    referrers: shownRefs,
    byComponentType,
    truncated,
    note:
      `${referenceCount} reference(s) (${kinds || 'none after the componentTypes filter'}) name a field called ` +
      `\`${fieldApiName}\` under ${matching.length} object id(s) that resolve to NO node in this vault. They are NOT counted in ` +
      '`totalCount` and they are NOT proven to be this field: an extractor that only knew an ALIAS for the object ' +
      "mints exactly this shape — the dotted prefix of a ReportType column's `<field>` element (a relationship path, " +
      'not the object api name), a case-variant object spelling, or an object this refresh never retrieved — and so ' +
      'does a genuinely different field that happens to share the name. For a COMMON api name most of these rows will ' +
      "be OTHER objects' same-named fields, not this one. THE VAULT CANNOT TELL THEM APART — open the referrers listed " +
      'here, or grep the api name under `{vaultRoot}/source/`, before treating the resolved count above as the whole ' +
      'footprint.' +
      ` The count and the componentType tally are EXACT over all ${matching.length} id(s).` +
      (truncated
        ? ` The ENUMERATED lists are a sample: ${shownIds.length} of ${matching.length} id(s) listed, referrer rows drawn from the first ${walked.length} of ${matching.length} id(s) and ${shownRefs.length} of ${referenceCount} row(s) shown.`
        : ''),
  });
};

/**
 * Shrink the unresolved section's ENUMERATED lists until the whole payload fits
 * the shared response budget.
 *
 * A new always-present section is not free. The widest field on a real vault
 * already serialises past the global budget on the whole-fits path (a
 * pre-existing gap: `limit` is a PER-SECTION page size, so a field whose every
 * bucket is under `limit` never pages no matter how many buckets it has), and a
 * borderline field must not be pushed over by a disclosure. The COUNTS and the
 * `note` are never dropped — they are the honest part, and they are ~1 KB — only
 * the enumeration shrinks, and `truncated` stays true whenever it did.
 *
 * WHICH CEILING, AND WHY IT WAS THE WRONG ONE. This fitted to
 * `responseBudgetBytes()` (40 000). Nothing is ever measured against that
 * number: `tool-dispatch` reduces against `responseBudgetBytes()` MINUS
 * `RESPONSE_ENVELOPE_RESERVE_BYTES` (38 976), and the body it measures also
 * carries `vaultState` / `contentPolicy` / `orgDrift`, which this handler never
 * sees. Fitting to 40 000 therefore certified "fits" for payloads landing in
 * the 38 976–40 000 window — measured: 3 of the 300 widest fields on a real
 * vault newly crossed 38 976 and fell into the global array-truncation pass on
 * answers that had returned whole. `toolLocalPayloadBudgetBytes()` is the
 * shared module's own answer to exactly this question (reduction cap minus a
 * measured margin for the fields added after the handler returns); adopting it
 * means this tool cannot drift from the guard again.
 */
const fitUnresolvedSection = (
  section: UnresolvedApiNameMatches,
  overheadBytes: number,
): UnresolvedApiNameMatches => {
  const budget = toolLocalPayloadBudgetBytes();
  // The shrink DISCLOSES itself in `note`, and that sentence is ~200 bytes the
  // fit must pay for. Measuring the pre-disclosure section and then appending
  // the sentence left the payload over the cap it had just certified — a fit
  // that does not weigh its own disclosure is the same class of error as a
  // budget measured against the wrong ceiling. `candidate` builds the FINAL
  // object, disclosure included, at every step of the search.
  const candidate = (
    refs: readonly FieldReference[],
    ids: readonly ComponentId[],
  ): UnresolvedApiNameMatches =>
    refs.length === section.referrers.length &&
    ids.length === section.unresolvedTargetIds.length
      ? section
      : {
          ...section,
          referrers: refs,
          unresolvedTargetIds: ids,
          truncated: true,
          note:
            `${section.note} The enumerated lists were shrunk further to fit the response ` +
            `budget (${refs.length} of ${section.referenceCount} referrer row(s), ${ids.length} of ` +
            `${section.idsTotal} id(s) listed); the COUNTS are unaffected. ` +
            'Re-run with a `componentTypes` filter to see the rows.',
        };
  const total = (
    refs: readonly FieldReference[],
    ids: readonly ComponentId[],
  ): number =>
    overheadBytes + Buffer.byteLength(JSON.stringify(candidate(refs, ids)), 'utf8');
  let refs = section.referrers;
  let ids = section.unresolvedTargetIds;
  while (total(refs, ids) > budget && refs.length > 0) {
    refs = refs.slice(0, Math.floor(refs.length / 2));
  }
  while (total(refs, ids) > budget && ids.length > 0) {
    ids = ids.slice(0, Math.floor(ids.length / 2));
  }
  // At a budget below what the COUNTS and the `note` alone cost, both lists are
  // now empty and the residue is disclosure prose. That prose is not dropped:
  // an answer that fits by deleting its own caveat is the defect this whole
  // change exists to remove. The global reducer trims arrays, and there are
  // none left for it to take.
  return candidate(refs, ids);
};

/**
 * The `sfi.find_field_anywhere` MCP tool. Given a `CustomField:` id,
 * returns every incoming reference (Apex reads/writes, Flow lookups,
 * Layout placements, formula refs, ValidationRule refs, SharingRule
 * refs) grouped by referrer ComponentType.
 *
 * @example
 *   const r = await findFieldAnywhereHandler(ctx, {
 *     targetId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.groups.length);
 */
export const findFieldAnywhereHandler = async (
  ctx: Context,
  input: FindFieldAnywhereInput,
): Promise<Result<McpResponse<FindFieldAnywhereOutput>, McpError>> => {
  // Accept `fieldId` as an alias for `targetId` (field-family parity).
  const rawTargetId = input.targetId ?? input.fieldId;
  if (rawTargetId === undefined) {
    return err({
      kind: 'invalid-query',
      message: `targetId (or its alias fieldId) is required and must be a '${CUSTOM_FIELD_PREFIX}' id`,
      path: 'targetId',
    });
  }
  if (!isCustomField(rawTargetId)) {
    return err({
      kind: 'invalid-query',
      message: `targetId must start with '${CUSTOM_FIELD_PREFIX}'; got '${rawTargetId}'`,
      path: 'targetId',
    });
  }
  const targetId = rawTargetId as ComponentId;
  const limit = input.limit ?? FIND_FIELD_ANYWHERE_DEFAULT_LIMIT;
  const typeFilter: ReadonlySet<string> | null =
    input.componentTypes !== undefined && input.componentTypes.length > 0
      ? new Set(input.componentTypes)
      : null;

  const edgesResult = await listEdges(ctx.graph, targetId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // EXISTENCE GATE (R4). `targetId` was validated by PREFIX only. Without this
  // gate four distinct causes produced a byte-identical
  // `{groups: [], totalCount: 0, byEdgeType: {}, truncated: false}` and three of
  // them were lies: a typo, a real field in the WRONG CASE (ids are
  // case-sensitive), a field the refresh never retrieved, and a real field that
  // genuinely is referenced nowhere. Only the last one may answer zero. The
  // handler already fetched this node below (for the folded report/dashboard
  // flags) and silently substituted `false` on null — ask FIRST, and route the
  // refusal through the same `fieldNotFoundError` + phantom-aware message the
  // sibling field tools use so the caller gets ranked `resolveSuggestions`.
  const targetNodeResult = await getNodeById(ctx.graph, targetId);
  if (!targetNodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${targetNodeResult.error.message}`,
    });
  }
  const targetNode = targetNodeResult.value;
  if (targetNode === null) {
    // A PHANTOM (edges exist, definition not retrieved) still has a true answer
    // to give, so only an id that is BOTH absent and unreferenced is refused.
    const referencingEdges = edgesResult.value.filter(
      (e) => e.edgeType !== 'parentOf',
    ).length;
    if (referencingEdges === 0) {
      return err(
        await fieldNotFoundError(
          ctx,
          targetId,
          await phantomAwareNotFoundMessage(ctx, targetId, 'CustomField'),
        ),
      );
    }
  }

  const collected: FieldReference[] = [];
  for (const edge of edgesResult.value) {
    // The parentOf edge is the containment edge from CustomObject and
    // does not represent a "use" of the field. Skip it so the universal
    // search returns only meaningful usages.
    if (edge.edgeType === 'parentOf') continue;
    const resolved = await resolveReference(ctx, edge);
    if (!resolved.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolved.error}`,
      });
    }
    if (resolved.value === null) continue;
    if (typeFilter !== null && !typeFilter.has(resolved.value.componentType)) {
      continue;
    }
    collected.push(resolved.value);
  }

  // Group by ComponentType (keyed as string so a cursor's `listId` indexes it).
  const byType = new Map<string, FieldReference[]>();
  for (const ref of collected) {
    const arr = byType.get(ref.componentType);
    if (arr === undefined) {
      byType.set(ref.componentType, [ref]);
    } else {
      arr.push(ref);
    }
  }

  // Sort within each group to a UNIQUE total order (compareRefs ends in
  // `source` — matches the edge PK — so section-offset resume is dup/skip-free).
  for (const arr of byType.values()) arr.sort(compareRefs);

  // Stable section order: ComponentType label ASC (also the existing group
  // order). Typed as string[] so a cursor's `listId` (string) can index it.
  const sortedTypes: readonly string[] = [...byType.keys()].sort();

  // CR-22 section cursor over the per-ComponentType buckets. `limit` is now the
  // per-SECTION page size (was a cross-group running cap). On a whole-fits call
  // (no cursor, every section ≤ limit) the response is byte-identical: every
  // section is emitted with its full references and NO cursor block. When a
  // section overflows, the DESIGNATED section is paged and the others are emitted
  // with empty `references` (their `count` preserved) + disclosed via
  // otherSections, so each is walkable section-by-section.
  // The scan for references the graph holds against a DIFFERENT, unresolvable id
  // carrying this field's api name. Unconditional: a CHECKED zero here is the
  // whole point, and a section that only appears when it has something to say is
  // indistinguishable from one that was never run.
  const unresolvedResult = await scanUnresolvedApiNameMatches(
    ctx,
    targetId,
    typeFilter,
  );
  if (!unresolvedResult.ok) return err(unresolvedResult.error);
  const unresolvedApiNameMatches = unresolvedResult.value;

  // The new section is BUDGETED, not free: the paged section must give back
  // exactly what the unresolved section takes, or the widest field turns from a
  // working answer into a truncated one. Both sides are measured against
  // `toolLocalPayloadBudgetBytes()` — the ONE number the global guard's
  // reduction cap is derived from — so they cannot drift apart.
  const unresolvedSectionBytes = Buffer.byteLength(
    JSON.stringify(unresolvedApiNameMatches),
    'utf8',
  );

  const TOOL = 'sfi.find_field_anywhere';
  const fingerprint = argsFingerprint({
    targetId,
    ...(input.componentTypes !== undefined ? { componentTypes: input.componentTypes } : {}),
  });

  // A no-cursor call is "paged" only when at least one section exceeds `limit`.
  const anyOverLimit = sortedTypes.some((t) => (byType.get(t) ?? []).length > limit);

  let designatedListId: string | null = sortedTypes.length > 0 ? (sortedTypes[0] as string) : null;
  let offset = 0;
  let isPaged = anyOverLimit;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
    isPaged = true;
  }

  const sections: readonly PageableSection<FieldReference>[] = sortedTypes.map((t) => ({
    listId: t,
    items: byType.get(t) ?? [],
  }));

  const groups: ReferenceGroup[] = [];
  let truncated = false;
  let cursorBlock:
    | { nextCursor: string; pageInfo: PageInfo; designatedList: string; otherSections: readonly SectionDisclosure[] }
    | undefined;

  if (!isPaged || designatedListId === null) {
    // Whole-fits: emit every section with its full references (today's shape).
    for (const type of sortedTypes) {
      const refs = byType.get(type) ?? [];
      groups.push({ componentType: type as ComponentType, references: refs, count: refs.length });
    }
  } else {
    // Truncated: page the designated section; emit the others with empty
    // references but their honest count. paginateSection mints the
    // continuation cursor for THIS section when it overflows.
    const pagedResult = paginateSection(sections, designatedListId, {
      offset,
      limit,
      // DERIVED from the shared budget, not a hand-maintained literal beside
      // it, and net of what the always-present unresolved section costs.
      byteBudget: Math.max(
        DESIGNATED_SECTION_FLOOR_BYTES,
        toolLocalPayloadBudgetBytes() - unresolvedSectionBytes,
      ),
      keyOf: (r) => `${r.componentId}|${r.edgeType}|${r.source}`,
      binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    });
    if (!pagedResult.ok) return err(pagedResult.error);
    const paged = pagedResult.value;
    truncated = true;
    for (const type of sortedTypes) {
      const refs = byType.get(type) ?? [];
      groups.push({
        componentType: type as ComponentType,
        references: type === designatedListId ? paged.items : [],
        count: refs.length,
      });
    }
    if (paged.pageInfo.nextCursor !== null) {
      // The designated section still has more — resume it.
      cursorBlock = {
        nextCursor: paged.pageInfo.nextCursor,
        pageInfo: paged.pageInfo,
        designatedList: paged.listId,
        otherSections: paged.otherSections,
      };
    } else {
      // Designated section exhausted; roll the cursor forward to the NEXT
      // non-empty section at offset 0 so the next call pages it (the whole
      // nested result stays walkable section-by-section). No re-emit this call.
      const idx = sortedTypes.indexOf(designatedListId);
      const nextType = sortedTypes
        .slice(idx + 1)
        .find((t) => (byType.get(t) ?? []).length > 0);
      if (nextType !== undefined) {
        const token: PageCursorToken = {
          v: PAGE_CURSOR_VERSION,
          t: TOOL,
          h: ctx.manifest.sourceTreeHash,
          o: 0,
          q: fingerprint,
          listId: nextType,
        };
        cursorBlock = {
          nextCursor: encodeCursor(token),
          pageInfo: { ...paged.pageInfo, hasMore: true, nextCursor: encodeCursor(token) },
          // The cursor now advances the NEXT section, so report that as the list
          // it will page on resume.
          designatedList: nextType,
          otherSections: paged.otherSections,
        };
      }
    }
  }

  // byEdgeType tally over the FULL collected set (not the truncated
  // slice) so the user can see the unfiltered edge-type distribution.
  const byEdgeType: Record<string, number> = {};
  for (const ref of collected) {
    byEdgeType[ref.edgeType] = (byEdgeType[ref.edgeType] ?? 0) + 1;
  }

  // UNCONDITIONAL (was gated on `collected.length > 0`). The disclosures describe
  // the METHOD, and the method is the same whether the walk found six referrers
  // or none — gating them handed the emptiest, most dangerous answer the least
  // disclosure. See ZERO_IS_A_GRAPH_ZERO.
  const boundaries: string[] = [];
  boundaries.push(GRAPH_EDGE_WALK_DISCLOSURE);
  boundaries.push(MANAGED_PACKAGE_DISCLOSURE);
  if (collected.length === 0) boundaries.push(ZERO_IS_A_GRAPH_ZERO);
  if (unresolvedApiNameMatches.referenceCount > 0) {
    // A POINTER, not a second copy of `note`. The full explanation lives in the
    // typed section; duplicating ~900 bytes of it here pushed a real field's
    // payload past the global hard ceiling, and a disclosure that makes the
    // response un-returnable discloses nothing.
    boundaries.push(
      `${unresolvedApiNameMatches.referenceCount} reference(s) in this vault name a field called ` +
        `\`${unresolvedApiNameMatches.fieldApiName}\` under ${unresolvedApiNameMatches.idsTotal} object id(s) that ` +
        'resolve to NO node here (an object ALIAS — the dotted prefix of a ReportType column\'s `<field>` element, ' +
        'a case-variant spelling, or an object this refresh never retrieved). They are NOT counted in `totalCount` ' +
        "and NOT proven to be this field; for a common api name most will be OTHER objects' same-named fields. Read " +
        'the typed `unresolvedApiNameMatches` section before treating the count above as the whole footprint.',
    );
  }

  // Report / Dashboard field usage is folded onto the field as a PROPERTY by
  // `applyReportDashboardPersistence`, so it is invisible to the edge walk
  // above. REPORT-DASHBOARD-GRAPH-PERSISTENCE persists the Report/Dashboard
  // NODES (so `Report:{Folder}/{Name}` is now a real, inspectable component)
  // but deliberately NOT the analytics -> CustomField edges: at real-org scale
  // they were 94% of the persisted rows for an answer this property already
  // gives over EVERY extracted report. The property stays the authority here.
  // Surface it: a positive note when the field carries the folded usage,
  // otherwise the caveat that report usage is only modeled when the pull ran.
  // `targetNode` was resolved by the existence gate above; a null here can now
  // only mean PHANTOM (the gate refused the absent-and-unreferenced case). A
  // phantom target has NO node to carry the folded flags, so it gets the
  // phantom disclosure instead of a report/dashboard claim in either direction.
  const rdUsage = targetNode !== null ? reportDashboardUsage(targetNode) : null;
  if (rdUsage === null) {
    boundaries.push(phantomTargetDisclosure(targetId));
  } else if (rdUsage.usedInReport || rdUsage.usedInDashboard) {
    const where = [
      rdUsage.usedInReport ? 'report column(s) / filter(s)' : null,
      rdUsage.usedInDashboard ? 'dashboard component(s)' : null,
    ]
      .filter((s): s is string => s !== null)
      .join(' and ');
    boundaries.push(
      `This field IS used in ${where} (folded from the report/dashboard pull). Report/dashboard referrers are NOT edges, so they do not appear in the reference list above — read the folded \`usedInReports\` / \`usedInDashboards\` name list on the field (first 50, with an exact truncation total), or open the \`Report:{Folder}/{Name}\` node those names identify.`,
    );
  } else {
    boundaries.push(REPORT_DASHBOARD_USAGE_CAVEAT);
  }

  // Fit the new section to the budget LAST, against the real assembled payload.
  const fitted = fitUnresolvedSection(
    unresolvedApiNameMatches,
    Buffer.byteLength(
      JSON.stringify({
        targetId,
        groups,
        totalCount: collected.length,
        byEdgeType,
        boundaries,
        truncated,
        searchMethod: 'graph-edge-walk',
        ...(cursorBlock ?? {}),
      }),
      'utf8',
    ),
  );

  return ok({
    data: {
      targetId,
      groups,
      totalCount: collected.length,
      byEdgeType,
      boundaries,
      truncated,
      searchMethod: 'graph-edge-walk',
      unresolvedApiNameMatches: fitted,
      ...(cursorBlock !== undefined
        ? {
            nextCursor: cursorBlock.nextCursor,
            pageInfo: cursorBlock.pageInfo,
            designatedList: cursorBlock.designatedList,
            otherSections: cursorBlock.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
