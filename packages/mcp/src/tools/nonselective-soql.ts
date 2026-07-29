/**
 * Handler for the `sfi.nonselective_soql` MCP tool.
 *
 * The first INDEX-AWARE Apex static analysis in the product: an OFFLINE,
 * vault-only scan (livePlane `'never'`) that flags the unambiguous NON-SELECTIVE
 * SOQL shapes that cause full-scan / query-timeout risk at large data volume. For
 * every inline SOQL query in every non-test ApexClass / ApexTrigger it walks the
 * WHERE clause (parser-grade, via `@sf-intelligence/parsers/soql-selectivity` — a
 * focused walk over the SAME ANTLR tree the AST-edge pass uses) and classifies it
 * against an index set assembled from THIS org's declared custom indexes plus a
 * curated GENERAL Salesforce standard-index table:
 *
 *   - `nonselective-non-indexed-filters` (HIGH) — the CORE signal: the query has a
 *     WHERE clause but NO filter predicate references an INDEXED field. At scale
 *     the optimizer cannot narrow by index → full scan.
 *   - `leading-wildcard-like` (MEDIUM) — a `LIKE '%foo'` / `'%foo%'`; a leading
 *     wildcard cannot use an index.
 *   - `negative-operator-only` (MEDIUM) — the only filters are negative
 *     (`!=`, `<>`, `NOT IN`, `EXCLUDES`); negative predicates are non-selective.
 *   - `no-where-clause` (MEDIUM) — no WHERE at all; an unbounded read of the whole
 *     object (the SOQL sibling of the Flow `filterless-get-records` smell).
 *
 * The detection is a PURE function ({@link classifyQuery}) over a parsed query
 * fact + an {@link IndexOracle}, unit-testable with synthetic facts (no vault, no
 * Apex). The handler is the thin wrapper: it builds the per-object index set from
 * the graph, reads each Apex source ON DEMAND, runs the walker + classifier,
 * aggregates, and self-fits the page to the byte budget.
 *
 * HONESTY SPINE (this is the pass/fail axis — the tool is a SHAPE smell, NOT the
 * runtime query optimizer's verdict):
 *   - **Static shape, not a runtime selectivity verdict.** Salesforce's optimizer
 *     decides selectivity from ACTUAL row counts and thresholds the vault cannot
 *     know. A non-selective-SHAPED query against a SMALL table is completely fine.
 *     This is stated verbatim in `boundaries[]`.
 *   - **Row counts are unknown offline.** Disclosed.
 *   - **WHERE fields/operators are `parsed`; the index set is `declared` (custom
 *     indexes) + general Salesforce knowledge (the standard table).** Never
 *     presented as heuristic-certain.
 *   - **Dynamic SOQL is invisible.** `Database.query(str)` / `getQueryLocator(str)`
 *     and any string-built query are never seen — a disclosed recall gap.
 *   - **A file that does not parse is a NAMED blind spot** (`soundness`), never a
 *     silent "clean".
 *   - **Test classes are excluded** — a non-selective query in an `@isTest` class
 *     does not run at production data volume (mirrors `crud_fls_audit`).
 *   - **NOT a duplicate of `sfi.governor_limit_risks`,** which flags SOQL/DML
 *     INSIDE A LOOP (per-transaction limit count), a different axis from a single
 *     query's index selectivity. Stated verbatim.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type {
  SoqlOperator,
  SoqlSelectivityFact,
  SoqlWhereFilter,
} from '@sf-intelligence/parsers/soql-selectivity';
import { z } from 'zod';

import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { packToByteBudget } from './limit-headroom-report.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

// ---------------------------------------------------------------------------
// The curated GENERAL Salesforce standard-index table.
//
// Org-INDEPENDENT general Salesforce knowledge (treated like the Concept Model):
// the fields the platform indexes by default on (nearly) every object. NEVER a
// read of this org's data. Matched case-insensitively. Standard FOREIGN KEYS are
// handled by the `<Relationship>Id` naming rule below rather than enumerated.
// ---------------------------------------------------------------------------

/** GENERAL Salesforce standard-indexed field names (lowercased). Source: Salesforce indexing docs. */
export const STANDARD_INDEXED_FIELDS: ReadonlySet<string> = new Set<string>([
  'id',
  'name',
  'createdbyid',
  'createddate',
  'lastmodifiedbyid',
  'lastmodifieddate',
  'systemmodstamp',
  'ownerid',
  'recordtypeid',
  'division',
  'activitydate',
  // The unique developer-name index present on setup / metadata objects
  // (RecordType, Custom Metadata Types, …) — the canonical selective key there.
  'developername',
  // Email is a standard-indexed field on Contact / Lead (and treated generously
  // elsewhere — a generous index set under-reports, the safe direction).
  'email',
]);

/**
 * A field is a standard FOREIGN KEY when its api name ends in `Id` and it is NOT
 * a custom field (`__c`). Salesforce names every standard relationship field
 * `<Relationship>Id` (`AccountId`, `ParentId`, `WhatId`, `CreatedById`), and
 * foreign keys are indexed. This general rule keeps `WHERE ParentId = :x` from
 * being mis-flagged as non-indexed. Custom lookups end in `__c` and are resolved
 * via the CustomField `dataType` instead, so they never reach this test.
 */
export const isStandardForeignKeyName = (field: string): boolean =>
  /[A-Za-z0-9]Id$/.test(field) && !/__[a-z]+$/i.test(field);

// ---------------------------------------------------------------------------
// The PURE classifier core — unit-testable with synthetic facts, no vault.
// ---------------------------------------------------------------------------

/** The four non-selective rule ids this tool emits. */
export type NonSelectiveRule =
  | 'nonselective-non-indexed-filters'
  | 'leading-wildcard-like'
  | 'negative-operator-only'
  | 'no-where-clause';

/** Two-tier severity — the core "only non-indexed filters" rule is HIGH; the rest MEDIUM. */
export type NonSelectiveSeverity = 'high' | 'medium';

/** Comparison operators that are inherently non-selective (negative filters). */
const NEGATIVE_OPS: ReadonlySet<SoqlOperator> = new Set<SoqlOperator>([
  'neq',
  'notIn',
  'excludes',
]);

/** Positive (index-capable, given an indexed field + no leading wildcard) operators. */
const POSITIVE_OPS: ReadonlySet<SoqlOperator> = new Set<SoqlOperator>([
  'eq',
  'range',
  'in',
  'includes',
  'like',
]);

/**
 * The index knowledge for one query's FROM object. Pure — the handler supplies a
 * closure over the graph-derived index set; a unit test supplies a synthetic one.
 */
export interface IndexOracle {
  /**
   * True when the FROM object is present in the vault, so its custom indexes /
   * unique / externalId / lookup fields ARE known. When false, the object was not
   * retrieved and the index-dependent HIGH rule is SUPPRESSED (only operator-shape
   * rules fire) — a non-retrieved object's custom indexes are unknown, so flagging
   * "only non-indexed" would be a false positive.
   */
  readonly objectKnown: boolean;
  /** True when `field` (a bare, non-relationship api name) is an indexed field of the object. */
  readonly isIndexed: (field: string) => boolean;
}

/** The verdict for one query. `selective: true` ⇒ not flagged (no finding emitted). */
export interface QueryVerdict {
  readonly selective: boolean;
  readonly rule: NonSelectiveRule | null;
  readonly severity: NonSelectiveSeverity | null;
  readonly reason: string;
  /** Index-usable predicate fields that make the query selective (evidence). */
  readonly matchedIndexedFields: readonly string[];
}

/** True when a filter is a positive predicate (an attempt at selectivity, wildcard aside). */
const isPositivePredicate = (f: SoqlWhereFilter): boolean =>
  POSITIVE_OPS.has(f.operator) && !(f.operator === 'like' && f.leadingWildcard);

/**
 * True when a filter CAN use an index: a positive operator on an indexed field
 * (no leading wildcard). A relationship traversal (`Parent.Field`) is given the
 * benefit of the doubt — it typically leverages the parent foreign-key index and
 * the parent object's indexes cannot be resolved offline, so it is NOT flagged.
 */
const isIndexUsable = (f: SoqlWhereFilter, oracle: IndexOracle): boolean => {
  if (!isPositivePredicate(f)) return false;
  if (f.relationshipTraversal) return true;
  return oracle.isIndexed(f.field);
};

/** True when a filter is a positive predicate on a NON-indexed, non-relationship field. */
const isPositiveNonIndexed = (f: SoqlWhereFilter, oracle: IndexOracle): boolean => {
  if (!isPositivePredicate(f)) return false;
  if (f.relationshipTraversal) return false;
  return !oracle.isIndexed(f.field);
};

const uniqueSorted = (xs: readonly string[]): readonly string[] =>
  [...new Set(xs)].sort();

/**
 * PURE selectivity classifier. Given one parsed query fact + an index oracle,
 * returns whether the query is selective and (if not) which non-selective rule
 * fires. See the module JSDoc for the honesty framing.
 *
 * @example
 *   classifyQuery(fact, { objectKnown: true, isIndexed: (f) => f === 'Id' });
 */
export const classifyQuery = (
  fact: SoqlSelectivityFact,
  oracle: IndexOracle,
): QueryVerdict => {
  // 1. No resolvable top-level filters.
  if (fact.whereFilters.length === 0) {
    if (!fact.hasWhereClause) {
      return {
        selective: false,
        rule: 'no-where-clause',
        severity: 'medium',
        reason:
          'Query has no WHERE clause — an unbounded read that scans every row of the object at large data volume.',
        matchedIndexedFields: [],
      };
    }
    // A WHERE exists but every predicate was a SOQL function / unrecognized shape
    // the walker could not resolve to a plain field — cannot prove non-selective.
    return {
      selective: true,
      rule: null,
      severity: null,
      reason:
        'WHERE predicates could not be resolved to plain fields (SOQL function or unrecognized operator) — treated as potentially selective, not flagged.',
      matchedIndexedFields: [],
    };
  }

  // 2. Any index-usable predicate ⇒ at-least-potentially selective. The core
  //    "only non-indexed" rule is suppressed (leading-wildcard / negative shapes
  //    are independent, but a query with a real index filter is not a full scan).
  const usable = fact.whereFilters.filter((f) => isIndexUsable(f, oracle));
  if (usable.length > 0) {
    const matched = usable
      .filter((f) => !f.relationshipTraversal)
      .map((f) => f.field);
    return {
      selective: true,
      rule: null,
      severity: null,
      reason:
        'At least one filter uses an index-usable predicate on an indexed field (or a foreign-key relationship traversal) — the query is at-least-potentially selective.',
      matchedIndexedFields: uniqueSorted(matched),
    };
  }

  // 3. No index-usable filter → non-selective in SHAPE. Sub-classify by the
  //    dominant reason, HIGH first.
  const nonIndexedPositive = fact.whereFilters.filter((f) =>
    isPositiveNonIndexed(f, oracle),
  );
  if (nonIndexedPositive.length > 0 && oracle.objectKnown) {
    return {
      selective: false,
      rule: 'nonselective-non-indexed-filters',
      severity: 'high',
      reason: `No filter references an indexed field — the WHERE clause filters only on non-indexed field(s): ${uniqueSorted(
        nonIndexedPositive.map((f) => f.field),
      ).join(', ')}. At large data volume the optimizer cannot narrow by index.`,
      matchedIndexedFields: [],
    };
  }

  // Unknown object with a positive predicate: the object was not retrieved, so a
  // positive filter (`= :x`, `IN :ids`, a range) MIGHT be on an index we cannot
  // see (e.g. a managed-package lookup / unique field). Treat as potentially
  // selective rather than fall through to an operator-shape flag a hidden index
  // would moot — the "only non-indexed" rule is already suppressed above for an
  // unknown object, and this closes the mirror false positive on the MEDIUM rules.
  if (!oracle.objectKnown && fact.whereFilters.some(isPositivePredicate)) {
    return {
      selective: true,
      rule: null,
      severity: null,
      reason:
        'The FROM object is not in the vault, so a positive filter predicate cannot be confirmed non-indexed — treated as potentially selective, not flagged.',
      matchedIndexedFields: [],
    };
  }

  // 3b. Leading-wildcard LIKE — index-defeating regardless of the field.
  if (fact.hasLeadingWildcardLike) {
    const fields = uniqueSorted(
      fact.whereFilters.filter((f) => f.leadingWildcard).map((f) => f.field),
    );
    return {
      selective: false,
      rule: 'leading-wildcard-like',
      severity: 'medium',
      reason: `A LIKE with a leading wildcard ('%…') on ${fields.join(
        ', ',
      )} cannot use an index — the optimizer scans every row.`,
      matchedIndexedFields: [],
    };
  }

  // 3c. Only negative operators — non-selective regardless of index.
  if (fact.hasNegativeOperator) {
    const fields = uniqueSorted(
      fact.whereFilters
        .filter((f) => NEGATIVE_OPS.has(f.operator))
        .map((f) => f.field),
    );
    return {
      selective: false,
      rule: 'negative-operator-only',
      severity: 'medium',
      reason: `The only selective filters use a negative operator (!=, <>, NOT IN, EXCLUDES) on ${fields.join(
        ', ',
      )} — negative predicates are non-selective and cannot use an index.`,
      matchedIndexedFields: [],
    };
  }

  // 3d. No usable filter, but the object is not in the vault (custom indexes
  //     unknown) or the only predicates were unresolvable — do NOT flag (avoids a
  //     false positive on an object whose indexes we cannot see).
  return {
    selective: true,
    rule: null,
    severity: null,
    reason: oracle.objectKnown
      ? 'No index-usable filter resolved, but no positive non-indexed predicate either — not flagged.'
      : 'The FROM object is not in the vault, so its custom indexes are unknown — not flagged to avoid a false positive.',
    matchedIndexedFields: [],
  };
};

// ---------------------------------------------------------------------------
// The MCP handler.
// ---------------------------------------------------------------------------

/** Inclusive upper bound on the requested class-page `limit`. */
const NONSELECTIVE_MAX_LIMIT = 200;
/** Default requested class-page size. The real bound is the byte budget (self-fit). */
const NONSELECTIVE_DEFAULT_LIMIT = 50;
/** Self-fit target for the whole serialized body (below the 40 KB jsonResult budget). */
const NONSELECTIVE_RESPONSE_TARGET_BYTES = 36_000;
/** Note surfaced when the class page was byte-trimmed below the requested `limit`. */
const NONSELECTIVE_PAGE_NOTE =
  'This class page was trimmed below the requested `limit` to fit the response byte budget. No class was dropped: `nextOffset` equals `offset + classes.length`, so resume from it to walk the rest.';

/** ComponentTypes whose Apex source is scanned. */
const SCANNED_APEX_TYPES: readonly ComponentType[] = ['ApexClass', 'ApexTrigger'];
/** ComponentTypes read to assemble the index set. */
const INDEX_SOURCE_TYPES: readonly ComponentType[] = [
  'CustomObject',
  'CustomField',
  'Index',
];

// --- Verbatim boundary disclosures (the honesty spine) ---

const STATIC_SHAPE_DISCLOSURE =
  "This is a STATIC SHAPE smell, NOT the Salesforce query optimizer's runtime selectivity verdict. The optimizer decides selectivity from ACTUAL row counts and per-object thresholds this offline vault cannot know, so a non-selective-shaped query against a SMALL table is completely fine. Treat each finding as a prompt to check the expected data volume, not a proven full-scan.";
const ROW_COUNTS_DISCLOSURE =
  'Row counts are unknown offline — the vault holds metadata, not record volumes. A flag is about the query SHAPE only.';
const CONFIDENCE_DISCLOSURE =
  'The WHERE fields and operators are `parsed` (from the ANTLR SOQL parse of the Apex source). The index set is `declared` (this org\'s CustomIndex metadata + unique / externalId / lookup CustomField flags) unioned with GENERAL Salesforce standard-index knowledge (Id, Name, audit fields, RecordTypeId, OwnerId, and `<Relationship>Id` foreign keys). Neither axis is heuristic-certain.';
const DYNAMIC_SOQL_DISCLOSURE =
  'Dynamic SOQL is INVISIBLE: `Database.query(str)` / `Database.getQueryLocator(str)` and any string-concatenated query are never parsed as queries, so their WHERE clauses are not analyzed. Only inline `[SELECT …]` queries are scanned — a recall gap, so an empty result is "not seen", not "all selective".';
const TEST_CLASS_DISCLOSURE =
  'Test classes (`@isTest`) are excluded — a non-selective query in a test does not run at production data volume.';
const RELATIONSHIP_DISCLOSURE =
  'Relationship-traversal filters (`Parent.Field = …`) are treated as potentially selective: they typically use the parent foreign-key index, and the parent object\'s own indexes are not resolved offline. Fields whose name ends in `Id` are treated as indexed foreign keys per Salesforce naming.';
const NOT_GOVERNOR_DISCLOSURE =
  'This is NOT `sfi.governor_limit_risks`. That tool flags SOQL / DML INSIDE A LOOP (the per-transaction 100-SOQL / 150-DML limit count); this tool flags a single query\'s index SELECTIVITY (full-scan / timeout risk at volume) — a different axis.';
const OBJECT_UNKNOWN_DISCLOSURE =
  'For a query whose FROM object is not present in the vault (not retrieved), its custom indexes are unknown, so the HIGH "only non-indexed filters" rule is suppressed for it (only leading-wildcard / negative / no-WHERE shapes are flagged).';
const UNPARSED_APEX_NOTE =
  'Source could not be parsed for these Apex components, so their SOQL was NOT analyzed — an empty finding for them is "not checked", not proven clean.';

/** One flagged query. */
export interface NonSelectiveFinding {
  readonly rule: NonSelectiveRule;
  readonly severity: NonSelectiveSeverity;
  /** The FROM object of the flagged query. */
  readonly sObject: string;
  /** `ClassApiName:line` of the query. */
  readonly location: string;
  readonly reason: string;
}

/** One per-Apex-component entry with its flagged queries. */
export interface NonSelectiveClassEntry {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly findings: readonly NonSelectiveFinding[];
}

/** A named blind spot: an Apex component whose source could not be parsed. */
export interface NonSelectiveBlindSpot {
  readonly kind: 'unparsed-apex';
  readonly componentIds: readonly ComponentId[];
  readonly note: string;
}

/** Uniform soundness envelope (mirrors the static-analysis blind-spot shape). */
export interface NonSelectiveSoundness {
  readonly complete: boolean;
  readonly blindSpots: readonly NonSelectiveBlindSpot[];
  readonly staticCoverage: 'full' | 'partial';
}

/** Output payload. */
export interface NonSelectiveSoqlOutput {
  /** Per-component entries with ≥1 flagged query, sorted by componentId ASC (byte-paged). */
  readonly classes: readonly NonSelectiveClassEntry[];
  /** Components with ≥1 finding BEFORE the page slice. */
  readonly totalClassCount: number;
  /** Apex components actually read + parsed this run. */
  readonly scannedComponentCount: number;
  /** Inline SOQL queries examined across all non-test components. */
  readonly totalQueryCount: number;
  /** Queries flagged (a subset of `totalQueryCount`). */
  readonly flaggedQueryCount: number;
  /** Total findings across all flagged components (FULL, pre-slice). */
  readonly totalFindingCount: number;
  /** Per-rule counter across the FULL matched set. */
  readonly byRule: Readonly<Record<string, number>>;
  /** Per-FROM-object counter across the FULL matched set (top offenders). */
  readonly byObject: Readonly<Record<string, number>>;
  /** Verbatim honesty disclosures; the static-shape spine is always present. */
  readonly boundaries: readonly string[];
  /** True when the class-level slice was trimmed (by count or byte budget). */
  readonly truncated: boolean;
  /** Static blind spots: `complete: false` when an Apex source could not be parsed. */
  readonly soundness: NonSelectiveSoundness;
  readonly trust: TrustSummary;
  /** Page size echoed. Present only on a PAGED response. */
  readonly limit?: number;
  /** Zero-based offset of the first returned class. Present only when paged. */
  readonly offset?: number;
  /** Offset to resume from (== `offset + classes.length`). Present only when `truncated`. */
  readonly nextOffset?: number;
  /** True when the page was byte-trimmed below `limit`. Present only when trimmed. */
  readonly byteTrimmed?: boolean;
  /** Human note for a byte-trimmed page. Present only when `byteTrimmed`. */
  readonly pageNote?: string;
}

/** Zod schema — `limit` (1..200, default 50) + `offset` page the flagged-component list. */
export const nonselectiveSoqlInputSchema = z.object({
  limit: z.number().int().min(1).max(NONSELECTIVE_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export type NonselectiveSoqlInput = z.infer<typeof nonselectiveSoqlInputSchema>;

/** The graph-derived index knowledge: known objects + their indexed field names. */
interface IndexModel {
  readonly knownObjects: ReadonlySet<string>;
  /** obj apiName (lower) → indexed field api names (lower). */
  readonly indexedByObject: ReadonlyMap<string, ReadonlySet<string>>;
}

/** True when a CustomField node denotes an indexed field (unique / externalId / lookup / master-detail). */
const isIndexedCustomField = (node: Node): boolean => {
  const p = node.properties;
  if (p['unique'] === true) return true;
  if (p['externalId'] === true) return true;
  const dt = p['dataType'];
  return dt === 'Lookup' || dt === 'MasterDetail';
};

/** Parse `CustomObject:{Name}` parentId → the object api name (lowercased). */
const objectOfParent = (parentId: string | null): string | null => {
  if (parentId === null) return null;
  const prefix = 'CustomObject:';
  if (!parentId.startsWith(prefix)) return null;
  return parentId.slice(prefix.length).toLowerCase();
};

/** Build the per-object index set from CustomObject / CustomField / Index nodes. */
const buildIndexModel = (nodes: readonly Node[]): IndexModel => {
  const knownObjects = new Set<string>();
  const indexedByObject = new Map<string, Set<string>>();
  const add = (objLower: string, fieldLower: string): void => {
    let set = indexedByObject.get(objLower);
    if (set === undefined) {
      set = new Set<string>();
      indexedByObject.set(objLower, set);
    }
    set.add(fieldLower);
  };
  for (const node of nodes) {
    if (node.type === 'CustomObject') {
      knownObjects.add(node.apiName.toLowerCase());
      continue;
    }
    if (node.type === 'CustomField') {
      if (!isIndexedCustomField(node)) continue;
      const obj = objectOfParent(node.parentId);
      if (obj !== null) add(obj, node.apiName.toLowerCase());
      continue;
    }
    if (node.type === 'Index') {
      const obj = objectOfParent(node.parentId);
      if (obj === null) continue;
      const fields = node.properties['fields'];
      if (!Array.isArray(fields)) continue;
      for (const entry of fields) {
        const name =
          entry !== null && typeof entry === 'object'
            ? (entry as { name?: unknown }).name
            : undefined;
        if (typeof name === 'string' && name.length > 0) {
          add(obj, name.toLowerCase());
        }
      }
    }
  }
  return { knownObjects, indexedByObject };
};

/** Build the {@link IndexOracle} for one query's FROM object. */
const oracleForObject = (model: IndexModel, sObject: string): IndexOracle => {
  const objLower = sObject.toLowerCase();
  const set = model.indexedByObject.get(objLower);
  return {
    objectKnown: model.knownObjects.has(objLower),
    isIndexed: (field: string): boolean => {
      const fl = field.toLowerCase();
      if (STANDARD_INDEXED_FIELDS.has(fl)) return true;
      if (isStandardForeignKeyName(field)) return true;
      return set?.has(fl) === true;
    },
  };
};

/** Read + parse ONE Apex component's source on demand and classify its queries. */
const auditOneComponent = async (
  ctx: Context,
  node: Node,
  model: IndexModel,
  extract: (typeof import('@sf-intelligence/parsers/soql-selectivity'))['extractSoqlSelectivityFacts'],
): Promise<
  | { readonly ok: true; readonly findings: NonSelectiveFinding[]; readonly queryCount: number }
  | { readonly ok: false }
> => {
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return { ok: false };
  }
  let source: string;
  try {
    source = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return { ok: false };
  }
  const kind = node.type === 'ApexTrigger' ? 'trigger' : 'class';
  const extraction = extract(source, { kind });
  if (extraction.parseError !== null) return { ok: false };

  const findings: NonSelectiveFinding[] = [];
  for (const fact of extraction.queries) {
    const verdict = classifyQuery(fact, oracleForObject(model, fact.sObject));
    if (verdict.selective || verdict.rule === null || verdict.severity === null) {
      continue;
    }
    findings.push({
      rule: verdict.rule,
      severity: verdict.severity,
      sObject: fact.sObject,
      location: `${node.apiName}:${fact.line.toString()}`,
      reason: verdict.reason,
    });
  }
  return { ok: true, findings, queryCount: extraction.queries.length };
};

/**
 * The `sfi.nonselective_soql` MCP tool. See the module JSDoc for the rule set,
 * the index set, and the honesty spine.
 *
 * @example
 *   const r = await nonselectiveSoqlHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalFindingCount);
 */
export const nonselectiveSoqlHandler = async (
  ctx: Context,
  input: NonselectiveSoqlInput,
): Promise<Result<McpResponse<NonSelectiveSoqlOutput>, McpError>> => {
  const limit = input.limit ?? NONSELECTIVE_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // 1. Assemble the index set from the graph.
  const indexScan = await scanAllNodesOfTypes(ctx.graph, INDEX_SOURCE_TYPES);
  if (!indexScan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${indexScan.error.message}` });
  }
  const model = buildIndexModel(indexScan.value.nodes);

  // 2. Scan the Apex components.
  const apexScan = await scanAllNodesOfTypes(ctx.graph, SCANNED_APEX_TYPES);
  if (!apexScan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${apexScan.error.message}` });
  }

  // Lazy-load the ANTLR-backed walker only when the tool actually runs (keeps the
  // ~5 MB grammar out of the server's eager module graph — mirrors parsers/apex-ast).
  const { extractSoqlSelectivityFacts } = await import(
    '@sf-intelligence/parsers/soql-selectivity'
  );

  const entries: NonSelectiveClassEntry[] = [];
  const byRule: Record<string, number> = {};
  const byObject: Record<string, number> = {};
  const unparsedIds: ComponentId[] = [];
  let scannedComponentCount = 0;
  let totalQueryCount = 0;
  let flaggedQueryCount = 0;
  let totalFindingCount = 0;
  let sawUnknownObject = false;

  for (const node of apexScan.value.nodes) {
    // Exclude test classes — a non-selective query there never hits prod volume.
    if (node.properties['isTest'] === true) continue;
    const audited = await auditOneComponent(
      ctx,
      node,
      model,
      extractSoqlSelectivityFacts,
    );
    if (!audited.ok) {
      unparsedIds.push(node.id);
      continue;
    }
    scannedComponentCount += 1;
    totalQueryCount += audited.queryCount;
    if (audited.findings.length === 0) continue;
    for (const f of audited.findings) {
      byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      byObject[f.sObject] = (byObject[f.sObject] ?? 0) + 1;
      if (!model.knownObjects.has(f.sObject.toLowerCase())) sawUnknownObject = true;
      totalFindingCount += 1;
      flaggedQueryCount += 1;
    }
    entries.push({
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      findings: audited.findings,
    });
  }

  entries.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );

  // 3. Soundness + boundaries.
  const soundness: NonSelectiveSoundness =
    unparsedIds.length === 0
      ? { complete: true, blindSpots: [], staticCoverage: 'full' }
      : {
          complete: false,
          blindSpots: [
            {
              kind: 'unparsed-apex',
              componentIds: [...unparsedIds].sort(),
              note: UNPARSED_APEX_NOTE,
            },
          ],
          staticCoverage: 'partial',
        };

  const boundaries: string[] = [
    STATIC_SHAPE_DISCLOSURE,
    ROW_COUNTS_DISCLOSURE,
    CONFIDENCE_DISCLOSURE,
    DYNAMIC_SOQL_DISCLOSURE,
    TEST_CLASS_DISCLOSURE,
    RELATIONSHIP_DISCLOSURE,
    NOT_GOVERNOR_DISCLOSURE,
  ];
  if (sawUnknownObject) boundaries.push(OBJECT_UNKNOWN_DISCLOSURE);
  if (apexScan.value.scanIncomplete || indexScan.value.scanIncomplete) {
    const incomplete = [
      ...apexScan.value.incompleteTypes,
      ...indexScan.value.incompleteTypes,
    ];
    boundaries.push(scanTruncationNote(incomplete, clampedNodeScanLimit()));
  }
  if (unparsedIds.length > 0) boundaries.push(UNPARSED_APEX_NOTE);

  const completeness: TrustSummary['completeness'] =
    unparsedIds.length === 0
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage: ['ApexClass / ApexTrigger (unparseable source)'] };
  const trust = offlineTrust(ctx, completeness);
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // 4. Self-fitting class page (cursor-honest — see limit_headroom_report).
  const fixedBody = {
    data: {
      classes: [] as NonSelectiveClassEntry[],
      totalClassCount: entries.length,
      scannedComponentCount,
      totalQueryCount,
      flaggedQueryCount,
      totalFindingCount,
      byRule,
      byObject,
      boundaries,
      truncated: true,
      soundness,
      trust,
      limit,
      offset,
      nextOffset: offset,
      byteTrimmed: true,
      pageNote: NONSELECTIVE_PAGE_NOTE,
    },
    vaultState,
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(fixedBody), 'utf8');
  const classesBudget = Math.max(0, NONSELECTIVE_RESPONSE_TARGET_BYTES - fixedBytes);
  const packed = packToByteBudget(
    entries,
    offset,
    limit,
    classesBudget,
    (e) => Buffer.byteLength(JSON.stringify(e), 'utf8') + 1,
  );
  const isPaged = packed.truncated || offset > 0 || packed.byteTrimmed;

  return ok({
    data: {
      classes: packed.page,
      totalClassCount: entries.length,
      scannedComponentCount,
      totalQueryCount,
      flaggedQueryCount,
      totalFindingCount,
      byRule,
      byObject,
      boundaries,
      truncated: packed.truncated,
      soundness,
      trust,
      ...(isPaged ? { limit, offset } : {}),
      ...(packed.truncated ? { nextOffset: packed.nextOffset } : {}),
      ...(packed.byteTrimmed ? { byteTrimmed: true, pageNote: NONSELECTIVE_PAGE_NOTE } : {}),
    },
    vaultState,
  });
};
