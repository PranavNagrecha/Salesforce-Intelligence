/**
 * Handler for the `sfi.doc_coverage_report` MCP tool.
 *
 * The OFFLINE, vault-only documentation-GAP meter. It rolls the two
 * documentation axes the extractors DO capture — a component's `description`
 * and a field's `inlineHelpText` — into a scored, LOWEST-COVERAGE-FIRST report
 * broken down by object, and WEIGHTS each undocumented component by its graph
 * edge-degree (a real criticality proxy — an undocumented, heavily-referenced
 * field ranks above an undocumented orphan). It is the DOCUMENTATION axis that
 * `sfi.tech_debt_score` lacks: where is the org's metadata undocumented, and
 * which undocumented components matter most.
 *
 * It MEASURES gaps; it does NOT PRODUCE docs. It is deliberately NOT the
 * documentation GENERATORS (`sfi.generate_data_dictionary` /
 * `sfi.generate_admin_handbook` / the doc-tier generators): those write the
 * missing descriptions; this one finds where they are missing and ranks them.
 *
 * ARCHITECTURE — a PURE core ({@link rollupDocCoverage} + {@link rankGroupsWorstFirst}
 * + {@link paginateDocCoverage}) takes per-node `{ descriptionMeasurable,
 * hasDescription, helpTextMeasurable, hasHelpText, degree, type, group,
 * orgOwned }` inputs and returns per-object coverage scores + a degree-ranked
 * "highest-impact undocumented" list. It is unit-testable with NO vault. The
 * handler is the thin MCP wrapper: it scans the CustomObject / CustomField
 * nodes, reads presence from `node.properties`, joins each node to its inbound
 * edge-degree (the criticality weight), rolls up per object, ranks
 * worst-covered first, self-fits the page to the response byte budget, and
 * builds the honesty spine.
 *
 * HONESTY SPINE (this is the load-bearing part — "not measurable" ≠ "undocumented"):
 *   - **This version deliberately SCOPES the gap to two families** —
 *     CustomObject `<description>` and CustomField `<description>` /
 *     `<inlineHelpText>`. Other description-bearing families (Flow,
 *     ValidationRule, PermissionSet, RecordType, ReportType, Role, …) DO carry
 *     captured descriptions in the vault but are OUT OF SCOPE for this version —
 *     a deliberate scope choice, NOT a claim that their description is
 *     uncaptured — so their real doc gaps are simply not measured here
 *     (extending the scanned set to them is a future enhancement).
 *   - **SEPARATELY and genuinely, a family the extractor does NOT capture a
 *     description for, or that the refresh did not retrieve, is NOT MEASURABLE**
 *     and is excluded (the coverage floor). Either way a not-measurable node is
 *     NEVER counted as a gap, never read as "undocumented"; the scope is
 *     disclosed.
 *   - **Scoped to what the ORG owns.** The undocumented count covers CUSTOM,
 *     non-managed components (`__c`/`__mdt`/… fields + custom objects the org
 *     authored). Standard fields (Salesforce-provided help / no extractable
 *     description) and managed-package (`ns__…`) components are reported
 *     SEPARATELY as out-of-scope and never penalize the org.
 *   - **`description` absence and `inlineHelpText` absence are distinct axes**
 *     (both reported, never conflated). Objects carry no inline help text, so
 *     they are NOT MEASURABLE on the help-text axis (excluded from it).
 *   - **Coverage floor.** Only families the refresh retrieved are measured; an
 *     un-retrieved family is EXCLUDED (not scored 0%). Presence is `declared`
 *     (structural); the degree weight is a real inbound-edge graph measure.
 *   - **"Documented" means a NON-EMPTY field, not a QUALITY judgment** — a
 *     one-word description still counts as present.
 */

import type {
  ComponentType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { isNamespaced, packToByteBudget } from './limit-headroom-report.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

// ---------------------------------------------------------------------------
// Scope constants.
// ---------------------------------------------------------------------------

/**
 * The metadata families this version SCOPES the documentation gap to. Both
 * carry a captured source `<description>` in `node.properties` (and CustomField
 * also `<inlineHelpText>`). This is a deliberate SCOPE choice, NOT the full set
 * of description-bearing families: Flow / ValidationRule / PermissionSet /
 * RecordType / ReportType / Role also carry captured descriptions in the vault
 * but are OUT OF SCOPE for this version (extending this list to them is a future
 * enhancement — see the disclosure). A family this tool does not scan is simply
 * NOT MEASURED here, never counted as a gap.
 */
const MEASURED_TYPES: readonly ComponentType[] = ['CustomObject', 'CustomField'];

/** Inclusive upper bound on the requested object-page `limit`. */
const DOC_COVERAGE_MAX_LIMIT = 100;
/**
 * Default requested object-page size. The real bound is the BYTE budget: the
 * handler self-fits the object slice ({@link packToByteBudget}) so the response
 * lands under {@link DOC_COVERAGE_RESPONSE_TARGET_BYTES} and the central guard
 * never has to tail-truncate the array (which would leave a hand-set
 * `nextOffset` stale — the cursor-integrity bug this closes).
 */
const DOC_COVERAGE_DEFAULT_LIMIT = 20;
/** Cap on the degree-ranked "highest-impact undocumented" list (page-independent). */
const TOP_UNDOCUMENTED_CAP = 15;
/**
 * Self-fit target for the WHOLE serialized `{ data, vaultState }` body. Sits
 * below the central jsonResult 40 KB budget with headroom for the central
 * vaultState stamping, so sizing the object page HERE keeps the cursor honest.
 */
const DOC_COVERAGE_RESPONSE_TARGET_BYTES = 36_000;
/** Note surfaced when the object page was byte-trimmed below the requested `limit`. */
const DOC_COVERAGE_PAGE_NOTE =
  'This object page was trimmed below the requested `limit` to fit the response byte budget. No ranked object was dropped: `nextOffset` equals `offset + objects.length`, so resume from it to walk the rest.';

// ---------------------------------------------------------------------------
// Verbatim boundary disclosures (the honesty spine).
// ---------------------------------------------------------------------------

const MEASURABLE_SCOPE_DISCLOSURE =
  '"Not measurable" ≠ "undocumented". SCOPE (a deliberate choice this version makes): the documentation gap is measured for TWO families only — CustomObject `<description>` and CustomField `<description>` / `<inlineHelpText>`. Other description-bearing families — Flow, ValidationRule, PermissionSet, RecordType, ReportType, Role — DO carry captured descriptions in the vault, but are OUT OF SCOPE for this version; their real doc gaps are simply not measured here (this is a scope decision, NOT a claim that their description is uncaptured — extending the scanned set to them is a future enhancement). SEPARATELY and genuinely: a family whose description the extractor does NOT capture, or that the refresh did not retrieve, is NOT MEASURABLE and is excluded (see the coverage-floor disclosure). Either way a not-measurable node is never counted as a gap. Objects carry no inline help text, so they are not measurable on the help-text axis.';

const CUSTOM_VS_STANDARD_DISCLOSURE =
  'Scoped to what the ORG owns. The undocumented count covers CUSTOM, non-managed components the org authored: custom fields (`__c`) and custom objects (`__c`/`__mdt`/`__e`/`__b`/`__x`). Standard fields (which often carry Salesforce-provided help or no extractable description the org controls) and managed-package (`ns__…`) components are reported SEPARATELY as out-of-scope (`outOfScopeCount`) and are never counted against the org.';

const COVERAGE_FLOOR_DISCLOSURE =
  'Coverage is a floor: only metadata FAMILIES the last refresh retrieved are measured. An un-retrieved family is EXCLUDED from the report (not scored 0% documented) — a floor on the real gap, not the truth. Presence is `declared` (structural); the degree weight is a real inbound-edge graph measure, not a subjective importance knob.';

const DOCUMENTED_MEANING_DISCLOSURE =
  '"Documented" means a NON-EMPTY field, NOT a QUALITY judgment: a one-word or placeholder description still counts as present. This measures documentation PRESENCE, not documentation quality or accuracy.';

const NOT_A_GENERATOR_DISCLOSURE =
  'This MEASURES documentation gaps; it does NOT produce docs. To WRITE the missing descriptions use the documentation generators (`sfi.generate_data_dictionary` / `sfi.generate_admin_handbook`); this is the documentation axis `sfi.tech_debt_score` lacks.';

// ---------------------------------------------------------------------------
// The PURE core — unit-testable without a vault.
// ---------------------------------------------------------------------------

/**
 * One node's documentation signal, already classified by the handler (or a
 * unit test) so the roll-up is pure. `descriptionMeasurable` / `helpTextMeasurable`
 * are the "not measurable ≠ undocumented" flags: a node not measurable on an
 * axis is EXCLUDED from that axis's denominator. `orgOwned` gates whether the
 * node counts toward the gap at all (custom, non-managed) or is folded into the
 * out-of-scope tally (standard / managed-package).
 */
export interface DocNodeInput {
  readonly componentId: string;
  readonly apiName: string;
  /** `'CustomField'` | `'CustomObject'` (or any type, for the not-measurable test). */
  readonly type: string;
  /** The grouping key — the owning object api name (self for objects). */
  readonly group: string;
  /** Real inbound graph edge-degree (criticality weight). */
  readonly degree: number;
  /** True when this is a CUSTOM, non-managed component the org authored. */
  readonly orgOwned: boolean;
  /** True when the extractor captures this node's `description` (else NOT measurable). */
  readonly descriptionMeasurable: boolean;
  /** True when `properties.description` is a non-empty string. */
  readonly hasDescription: boolean;
  /** True when the extractor captures this node's `inlineHelpText` (fields only). */
  readonly helpTextMeasurable: boolean;
  /** True when `properties.inlineHelpText` is a non-empty string. */
  readonly hasHelpText: boolean;
}

/** One documentation axis (description OR inlineHelpText) rolled up over a set of nodes. */
export interface AxisRollup {
  /** Denominator: measurable, org-owned nodes on this axis. */
  readonly measurable: number;
  /** Numerator: measurable, org-owned nodes with a non-empty field. */
  readonly documented: number;
  /** Measurable, org-owned nodes with an EMPTY field (the gap). */
  readonly undocumented: number;
  /** `documented / measurable * 100`, one decimal; `null` when `measurable === 0`. */
  readonly coveragePct: number | null;
}

/** One object's documentation coverage, both axes + the degree-weighted debt. */
export interface GroupDocCoverage {
  /** The owning object api name. */
  readonly group: string;
  /** The CustomObject node id when it was in the scan, else `null`. */
  readonly componentId: string | null;
  readonly description: AxisRollup;
  readonly helpText: AxisRollup;
  /**
   * `(descriptionDocumented + helpTextDocumented) / (descriptionMeasurable +
   * helpTextMeasurable) * 100`, one decimal; `null` when the group has NO
   * measurable org-owned member on either axis. The worst-first sort key.
   */
  readonly combinedCoveragePct: number | null;
  /** Sum of inbound degree over this group's UNDOCUMENTED measurable members (the debt weight). */
  readonly undocumentedDegreeWeight: number;
  /** Measurable, org-owned members in this group. */
  readonly memberCount: number;
  /** Members EXCLUDED because their type is not measurable (disclosed, never counted). */
  readonly notMeasurableCount: number;
  /** Members EXCLUDED because they are standard / managed-package (out of org-owned scope). */
  readonly outOfScopeCount: number;
}

/** One highest-impact undocumented component (undocumented AND high-degree). */
export interface ImpactComponent {
  readonly componentId: string;
  readonly apiName: string;
  readonly type: string;
  readonly group: string;
  readonly degree: number;
  readonly missingDescription: boolean;
  readonly missingHelpText: boolean;
}

/** The full pure-core roll-up. */
export interface DocCoverageRollup {
  /** Per-object coverage, ranked LOWEST-COVERAGE-FIRST. */
  readonly groups: readonly GroupDocCoverage[];
  /** Highest-impact undocumented components, ranked by degree DESC (≤ {@link TOP_UNDOCUMENTED_CAP}). */
  readonly topUndocumented: readonly ImpactComponent[];
  /** Org-wide totals across every group. */
  readonly totals: {
    readonly description: AxisRollup;
    readonly helpText: AxisRollup;
    /** Nodes excluded because their type is not measurable. */
    readonly notMeasurableCount: number;
    /** Nodes excluded because they are standard / managed-package. */
    readonly outOfScopeCount: number;
    /** Total nodes fed to the roll-up. */
    readonly scannedCount: number;
  };
}

/** Round to one decimal place. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Coverage% for an axis, or `null` when there is nothing measurable to score. */
const coveragePct = (documented: number, measurable: number): number | null =>
  measurable === 0 ? null : round1((documented / measurable) * 100);

/** A working accumulator for one axis of one group. */
interface AxisAcc {
  measurable: number;
  documented: number;
}

/** A working accumulator for one group. */
interface GroupAcc {
  componentId: string | null;
  description: AxisAcc;
  helpText: AxisAcc;
  undocumentedDegreeWeight: number;
  memberCount: number;
  notMeasurableCount: number;
  outOfScopeCount: number;
}

/** Freeze an {@link AxisAcc} into the public {@link AxisRollup}. */
const finalizeAxis = (acc: AxisAcc): AxisRollup => ({
  measurable: acc.measurable,
  documented: acc.documented,
  undocumented: acc.measurable - acc.documented,
  coveragePct: coveragePct(acc.documented, acc.measurable),
});

/**
 * PURE documentation-coverage roll-up. Given classified per-node inputs, groups
 * by object, scores each axis (EXCLUDING not-measurable and out-of-scope nodes
 * from the gap denominators), degree-weights the undocumented members, and
 * builds the degree-ranked highest-impact list. No I/O, no graph — the handler
 * and the unit tests both call this.
 *
 * Honesty invariants baked in here:
 *   - A node with `descriptionMeasurable === false` never enters the description
 *     denominator/numerator (not "undocumented", just NOT MEASURABLE) — it is
 *     tallied in `notMeasurableCount`.
 *   - A node with `orgOwned === false` never enters any gap count — it is
 *     tallied in `outOfScopeCount` (standard / managed-package).
 *   - A node counts toward `notMeasurableCount` only when it is out of BOTH
 *     axes' measurable sets, so an object (measurable for description, not for
 *     help text) is NOT mislabeled not-measurable.
 */
export const rollupDocCoverage = (
  inputs: readonly DocNodeInput[],
): DocCoverageRollup => {
  const groups = new Map<string, GroupAcc>();
  const getGroup = (key: string): GroupAcc => {
    let acc = groups.get(key);
    if (acc === undefined) {
      acc = {
        componentId: null,
        description: { measurable: 0, documented: 0 },
        helpText: { measurable: 0, documented: 0 },
        undocumentedDegreeWeight: 0,
        memberCount: 0,
        notMeasurableCount: 0,
        outOfScopeCount: 0,
      };
      groups.set(key, acc);
    }
    return acc;
  };

  const totalDesc: AxisAcc = { measurable: 0, documented: 0 };
  const totalHelp: AxisAcc = { measurable: 0, documented: 0 };
  let totalNotMeasurable = 0;
  let totalOutOfScope = 0;
  const impact: ImpactComponent[] = [];

  for (const node of inputs) {
    const acc = getGroup(node.group);
    // Record the CustomObject id for the group so the handler can surface it.
    if (node.type === 'CustomObject' && node.apiName === node.group) {
      acc.componentId = node.componentId;
    }

    // Out-of-org-owned scope (standard field / managed-package): never a gap.
    if (!node.orgOwned) {
      acc.outOfScopeCount += 1;
      totalOutOfScope += 1;
      continue;
    }

    const descMeasurable = node.descriptionMeasurable;
    const helpMeasurable = node.helpTextMeasurable;

    // Not measurable on EITHER axis: excluded, disclosed, never counted.
    if (!descMeasurable && !helpMeasurable) {
      acc.notMeasurableCount += 1;
      totalNotMeasurable += 1;
      continue;
    }

    acc.memberCount += 1;
    let missingDescription = false;
    let missingHelpText = false;

    if (descMeasurable) {
      acc.description.measurable += 1;
      totalDesc.measurable += 1;
      if (node.hasDescription) {
        acc.description.documented += 1;
        totalDesc.documented += 1;
      } else {
        missingDescription = true;
      }
    }
    if (helpMeasurable) {
      acc.helpText.measurable += 1;
      totalHelp.measurable += 1;
      if (node.hasHelpText) {
        acc.helpText.documented += 1;
        totalHelp.documented += 1;
      } else {
        missingHelpText = true;
      }
    }

    if (missingDescription || missingHelpText) {
      acc.undocumentedDegreeWeight += node.degree;
      impact.push({
        componentId: node.componentId,
        apiName: node.apiName,
        type: node.type,
        group: node.group,
        degree: node.degree,
        missingDescription,
        missingHelpText,
      });
    }
  }

  // Only groups with at least one MEASURABLE org-owned member are ranked; a
  // group that was purely out-of-scope / not-measurable is folded into totals.
  const groupCoverages: GroupDocCoverage[] = [];
  for (const [group, acc] of groups) {
    if (acc.memberCount === 0) continue;
    const description = finalizeAxis(acc.description);
    const helpText = finalizeAxis(acc.helpText);
    const combinedMeasurable = description.measurable + helpText.measurable;
    const combinedDocumented = description.documented + helpText.documented;
    groupCoverages.push({
      group,
      componentId: acc.componentId,
      description,
      helpText,
      combinedCoveragePct: coveragePct(combinedDocumented, combinedMeasurable),
      undocumentedDegreeWeight: acc.undocumentedDegreeWeight,
      memberCount: acc.memberCount,
      notMeasurableCount: acc.notMeasurableCount,
      outOfScopeCount: acc.outOfScopeCount,
    });
  }

  const topUndocumented = rankImpactByDegree(impact).slice(0, TOP_UNDOCUMENTED_CAP);

  return {
    groups: rankGroupsWorstFirst(groupCoverages),
    topUndocumented,
    totals: {
      description: finalizeAxis(totalDesc),
      helpText: finalizeAxis(totalHelp),
      notMeasurableCount: totalNotMeasurable,
      outOfScopeCount: totalOutOfScope,
      scannedCount: inputs.length,
    },
  };
};

/**
 * Rank groups LOWEST-COVERAGE-FIRST: lowest `combinedCoveragePct` first; a group
 * with no measurable score (`null`) sorts LAST. Tiebreak by higher
 * `undocumentedDegreeWeight` (heavier documentation debt first — the criticality
 * weighting), then more members, then group name — a total order, deterministic.
 */
export const rankGroupsWorstFirst = (
  groups: readonly GroupDocCoverage[],
): readonly GroupDocCoverage[] =>
  [...groups].sort((a, b) => {
    const ac = a.combinedCoveragePct;
    const bc = b.combinedCoveragePct;
    if (ac === null && bc === null) {
      // both unscored — order by heavier debt, then name
    } else if (ac === null) {
      return 1;
    } else if (bc === null) {
      return -1;
    } else if (ac !== bc) {
      return ac - bc;
    }
    if (a.undocumentedDegreeWeight !== b.undocumentedDegreeWeight) {
      return b.undocumentedDegreeWeight - a.undocumentedDegreeWeight;
    }
    if (a.memberCount !== b.memberCount) return b.memberCount - a.memberCount;
    return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
  });

/**
 * Rank undocumented components HIGHEST-IMPACT-FIRST: highest inbound degree
 * first (the criticality weight), tiebreak by componentId ASC for determinism.
 * This is what surfaces "undocumented AND heavily-referenced" above an
 * undocumented orphan.
 */
export const rankImpactByDegree = (
  impact: readonly ImpactComponent[],
): readonly ImpactComponent[] =>
  [...impact].sort((a, b) =>
    a.degree !== b.degree
      ? b.degree - a.degree
      : a.componentId < b.componentId
        ? -1
        : a.componentId > b.componentId
          ? 1
          : 0,
  );

/** Result of packing the ranked group list into a byte budget. */
export interface DocCoveragePage {
  readonly page: readonly GroupDocCoverage[];
  /** ALWAYS `offset + page.length` — the cursor never overstates the advance. */
  readonly nextOffset: number;
  readonly truncated: boolean;
  /** True when the page stopped for the BYTE budget before reaching `limit`/end. */
  readonly byteTrimmed: boolean;
}

/**
 * Paginate the ranked groups with a byte budget, delegating to the shared
 * cursor-integrity primitive {@link packToByteBudget}. The invariant
 * `nextOffset === offset + page.length` holds on a budget-trimmed page, so a
 * cursor walk following `nextOffset` never skips a ranked object.
 */
export const paginateDocCoverage = (
  groups: readonly GroupDocCoverage[],
  offset: number,
  limit: number,
  budgetBytes: number,
): DocCoveragePage => {
  const packed = packToByteBudget(
    groups,
    offset,
    limit,
    budgetBytes,
    // +1 for the array comma separator between elements.
    (g) => Buffer.byteLength(JSON.stringify(g), 'utf8') + 1,
  );
  return {
    page: packed.page,
    nextOffset: packed.nextOffset,
    truncated: packed.truncated,
    byteTrimmed: packed.byteTrimmed,
  };
};

// ---------------------------------------------------------------------------
// Node-classification helpers (pure — exported for tests).
// ---------------------------------------------------------------------------

/** True when an api name carries any custom suffix (`__c`/`__mdt`/`__e`/`__b`/`__x`). */
export const hasCustomSuffix = (apiName: string): boolean =>
  /__(c|mdt|e|b|x)$/i.test(apiName);

/** A CUSTOM, non-managed field the org authored (`__c`, not `ns__…`). */
const isOrgOwnedCustomField = (apiName: string): boolean =>
  /__c$/i.test(apiName) && !isNamespaced(apiName);

/** A CUSTOM, non-managed object the org authored (any custom suffix, not `ns__…`). */
const isOrgOwnedCustomObject = (apiName: string): boolean =>
  hasCustomSuffix(apiName) && !isNamespaced(apiName);

/** True when a `node.properties` string value is present and non-empty. */
const hasNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** Owning object api name for a field, from `CustomObject:{Object}` parentId. */
const groupForField = (node: Node): string => {
  if (typeof node.parentId === 'string' && node.parentId.startsWith('CustomObject:')) {
    return node.parentId.slice('CustomObject:'.length);
  }
  // Fallback: derive from `CustomField:{Object}.{Field}` id.
  const rest = node.id.startsWith('CustomField:')
    ? node.id.slice('CustomField:'.length)
    : node.id;
  const dot = rest.indexOf('.');
  return dot === -1 ? rest : rest.slice(0, dot);
};

/** Classify one scanned node into a {@link DocNodeInput}. */
const classifyNode = (node: Node, degree: number): DocNodeInput => {
  if (node.type === 'CustomObject') {
    return {
      componentId: node.id,
      apiName: node.apiName,
      type: 'CustomObject',
      group: node.apiName,
      degree,
      orgOwned: isOrgOwnedCustomObject(node.apiName),
      descriptionMeasurable: true,
      hasDescription: hasNonEmptyString(node.properties['description']),
      // Objects carry no inline help text — NOT MEASURABLE on that axis.
      helpTextMeasurable: false,
      hasHelpText: false,
    };
  }
  // CustomField.
  return {
    componentId: node.id,
    apiName: node.apiName,
    type: 'CustomField',
    group: groupForField(node),
    degree,
    orgOwned: isOrgOwnedCustomField(node.apiName),
    descriptionMeasurable: true,
    hasDescription: hasNonEmptyString(node.properties['description']),
    helpTextMeasurable: true,
    hasHelpText: hasNonEmptyString(node.properties['inlineHelpText']),
  };
};

// ---------------------------------------------------------------------------
// The MCP handler.
// ---------------------------------------------------------------------------

/** One row of the inbound-degree aggregate. */
interface InboundDegreeRow {
  readonly node_id: string;
  readonly deg: number;
}

/**
 * Compute inbound edge-degree (the criticality weight) for EVERY node in ONE
 * `GROUP BY` pass over the edges table — the "referenced by" measure. A node
 * with no inbound edge is absent from the map (degree 0). Raw connection query
 * mirrors `generate-architecture-overview`'s edge read.
 */
const computeInboundDegree = async (
  ctx: Context,
): Promise<Result<ReadonlyMap<string, number>, McpError>> => {
  try {
    const reader = await ctx.graph.connection.runAndReadAll(
      'SELECT to_id AS node_id, count(*)::INT AS deg FROM edges GROUP BY to_id',
    );
    const rows = reader.getRowObjectsJS() as unknown as readonly InboundDegreeRow[];
    const map = new Map<string, number>();
    for (const row of rows) map.set(String(row.node_id), Number(row.deg));
    return ok(map);
  } catch (cause) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** A per-metadata-family scope disclosure entry. */
export interface ScopeBlock {
  /** The families this report can measure (extractor captures description/help text). */
  readonly measurableTypes: readonly string[];
  /** Verbatim note on the measurable-vs-not-measurable boundary. */
  readonly note: string;
}

export interface DocCoverageReportOutput {
  /** Measurable-vs-not-measurable scope. */
  readonly scope: ScopeBlock;
  /** Org-wide totals across both axes + the excluded tallies. */
  readonly totals: DocCoverageRollup['totals'];
  /** Per-object coverage, ranked LOWEST-COVERAGE-FIRST, PAGED by `limit`/`offset`. */
  readonly objects: readonly GroupDocCoverage[];
  /** The degree-ranked highest-impact undocumented components (page-independent). */
  readonly topUndocumented: readonly ImpactComponent[];
  /** Object count BEFORE the page slice. */
  readonly totalObjectCount: number;
  /** Nodes actually scanned this run. */
  readonly scannedNodeCount: number;
  /** Coverage honesty: measured families whose retrieve is incomplete (a floor). */
  readonly coverage: {
    readonly incompleteFamilies: readonly string[];
    readonly note: string;
  };
  /** Verbatim honesty disclosures. */
  readonly boundaries: readonly string[];
  /** True when the object-level slice was trimmed to `limit` or the byte budget. */
  readonly truncated: boolean;
  readonly trust: TrustSummary;
  /** Requested page size echoed. Present only on a PAGED response. */
  readonly limit?: number;
  /** Zero-based offset of the first returned object. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass next. ALWAYS `offset + objects.length`. Present only when `truncated`. */
  readonly nextOffset?: number;
  /** True when the page was byte-trimmed below the requested `limit`. */
  readonly byteTrimmed?: boolean;
  /** Human note explaining a byte-trimmed page. Present only when `byteTrimmed`. */
  readonly pageNote?: string;
}

export const docCoverageReportInputSchema = z.object({
  /**
   * Requested object-page size (1..100, default 20). Upper bound on the RANKED
   * per-object slice; the page also self-fits the response byte budget, so a
   * large `limit` returns as many objects as fit with an honest `nextOffset`.
   */
  limit: z.number().int().min(1).max(DOC_COVERAGE_MAX_LIMIT).optional(),
  /** Zero-based offset for paging the ranked object list forward. */
  offset: z.number().int().min(0).optional(),
});

export type DocCoverageReportInput = z.infer<typeof docCoverageReportInputSchema>;

/** True when the manifest reports `complete` coverage for a family (or coverage is unknown). */
const coverageComplete = (ctx: Context, type: ComponentType): boolean => {
  const summary = summarizeCoverage(ctx.manifest, [type]);
  if (!summary.coverageKnown) return true; // legacy vault — do not false-flag
  return summary.status === 'complete';
};

/**
 * The `sfi.doc_coverage_report` MCP tool. See the module JSDoc for the scope,
 * the pure core, and the honesty spine.
 *
 * @example
 *   const r = await docCoverageReportHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.topUndocumented[0]);
 */
export const docCoverageReportHandler = async (
  ctx: Context,
  input: DocCoverageReportInput,
): Promise<Result<McpResponse<DocCoverageReportOutput>, McpError>> => {
  const limit = input.limit ?? DOC_COVERAGE_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const scan = await scanAllNodesOfTypes(ctx.graph, MEASURED_TYPES);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }

  const degreeResult = await computeInboundDegree(ctx);
  if (!degreeResult.ok) return degreeResult;
  const degreeById = degreeResult.value;

  const inputs: DocNodeInput[] = scan.value.nodes.map((node) =>
    classifyNode(node, degreeById.get(node.id) ?? 0),
  );

  const rollup = rollupDocCoverage(inputs);

  // Coverage honesty across the MEASURED families.
  const incompleteFamilies = MEASURED_TYPES.filter((t) => !coverageComplete(ctx, t));
  const completeness: TrustSummary['completeness'] =
    incompleteFamilies.length === 0
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage: [...incompleteFamilies].sort() };

  const boundaries: string[] = [
    MEASURABLE_SCOPE_DISCLOSURE,
    CUSTOM_VS_STANDARD_DISCLOSURE,
    COVERAGE_FLOOR_DISCLOSURE,
    DOCUMENTED_MEANING_DISCLOSURE,
    NOT_A_GENERATOR_DISCLOSURE,
  ];
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  const scope: ScopeBlock = {
    measurableTypes: [...MEASURED_TYPES],
    note: MEASURABLE_SCOPE_DISCLOSURE,
  };
  const coverageBlock = {
    incompleteFamilies: [...incompleteFamilies].sort(),
    note: COVERAGE_FLOOR_DISCLOSURE,
  };
  const trust = offlineTrust(ctx, completeness);
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // --- Self-fitting object page (cursor-honest) --------------------------
  // Size the ranked-object page HERE so the central jsonResult guard never has
  // to tail-truncate `data.objects` and leave a hand-set `nextOffset` stale.
  // Measure the fixed envelope WITH the pagination fields present, then give
  // the remaining budget to the object slice.
  const fixedBody = {
    data: {
      scope,
      totals: rollup.totals,
      objects: [] as GroupDocCoverage[],
      topUndocumented: rollup.topUndocumented,
      totalObjectCount: rollup.groups.length,
      scannedNodeCount: scan.value.nodes.length,
      coverage: coverageBlock,
      boundaries,
      truncated: true,
      trust,
      limit,
      offset,
      nextOffset: offset,
      byteTrimmed: true,
      pageNote: DOC_COVERAGE_PAGE_NOTE,
    },
    vaultState,
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(fixedBody), 'utf8');
  const objectsBudget = Math.max(0, DOC_COVERAGE_RESPONSE_TARGET_BYTES - fixedBytes);
  const packed = paginateDocCoverage(rollup.groups, offset, limit, objectsBudget);
  const isPaged = packed.truncated || offset > 0 || packed.byteTrimmed;

  return ok({
    data: {
      scope,
      totals: rollup.totals,
      objects: packed.page,
      topUndocumented: rollup.topUndocumented,
      totalObjectCount: rollup.groups.length,
      scannedNodeCount: scan.value.nodes.length,
      coverage: coverageBlock,
      boundaries,
      truncated: packed.truncated,
      trust,
      ...(isPaged ? { limit, offset } : {}),
      ...(packed.truncated ? { nextOffset: packed.nextOffset } : {}),
      ...(packed.byteTrimmed ? { byteTrimmed: true, pageNote: DOC_COVERAGE_PAGE_NOTE } : {}),
    },
    vaultState,
  });
};
