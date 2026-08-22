/**
 * Handler for the `sfi.object_360` MCP tool.
 *
 * The object-tier counterpart to `sfi.field_360`: ONE assembler that answers
 * "what IS this object, what is attached to it, what points at it, who can
 * touch it, and when did any of it last change" from the offline vault.
 *
 * ── This tool does not adjudicate deletability ──────────────────────────────
 *
 * It used to. It emitted a `deleteAssessment.verdict` (`blocked` /
 * `no-blockers-found` / `cannot-delete-standard-object`) and framed every
 * inbound edge as a `blocker`. That framing was WRONG on the facts: an object
 * with active flows, with profile grants, or with records is not thereby
 * undeletable — those are consequences to weigh, not refusals. A tool that
 * prints "blocked" turns a judgement call that belongs to the admin into a
 * machine verdict built on a partial edge graph.
 *
 * So there is no verdict, no `blockers[]`, and no field anywhere in this
 * response that says whether the reader can or cannot delete anything. What
 * replaces it is a BRIEF: dated facts and exact counts, each with the detail
 * behind it, organised along the one distinction that IS real —
 *
 *   `owns`  — components this object CONTAINS. Delete the object and these go
 *             with it. Enumerated by `parentId`.
 *   `usage` — components OUTSIDE this object that POINT AT it. They survive the
 *             object and are left dangling. Enumerated by inbound edge.
 *
 * That split is presentational, not a verdict: neither side is called blocking.
 *
 * ── An object's dependency surface is NOT its own inbound edges ─────────────
 *
 * Measured on a 129-object probe vault: object-tier inbound usage edges are a
 * small minority of the truth; the child `CustomField` tier carries the bulk.
 * An `object_360` built on the object node's own edges would see a fraction of
 * the surface. So `usage` computes BOTH tiers and reports them SEPARATELY
 * (never one blended number the reader cannot decompose), plus the DE-DUPLICATED
 * union of distinct referrers — one Flow that both `triggersOn` the object and
 * writes three of its fields is ONE dependency, not four.
 *
 * ── Phantom TARGETS are counted, not silently dropped ───────────────────────
 *
 * The field tier cannot be enumerated from `listChildren` alone. An edge whose
 * target is `CustomField:<Obj>.<X>` where NO node exists — platform/audit fields
 * (`Name`, `Id`, `OwnerId`, `CreatedById`), list-view column tokens
 * (`FULL_NAME`, `CREATEDBY_USER`), case-variant spellings (`CONTACT.EMAIL`) —
 * has no child node to hang off. Measured on the probe vault: **2,418 of 12,028
 * field-tier usage edges (20.1%) across 116 of 129 objects**, one object losing
 * 82% of its field-tier edges. This tool resolves those targets explicitly
 * (`danglingTargetIdsMatching`) and counts them, disclosing the unresolved tier
 * separately so a reader can tell a declared field from a token.
 *
 * ── Child enumeration is by `parentId`, never by edge ───────────────────────
 *
 * `parentOf` edges are NOT minted for every child family (ListView,
 * ConditionalContext and Role carry a `parentId` with ZERO `parentOf` edges),
 * so walking `parentOf` silently drops every list view an object owns. The child
 * census uses `listChildren` (a `parent_id` scan); edges are used only for the
 * usage tiers, where an edge IS the evidence.
 *
 * ── Absent is never `false`, and empty is never "none" ──────────────────────
 *
 * The object extractor writes `false` for a boolean the source XML never
 * declared, so a `false` on `enableReports` is indistinguishable from
 * "not declared". Reporting it as `false` told an admin "this object cannot be
 * reported on" in the same response that named dozens of its report-referenced
 * fields. Every such flag is therefore tri-state here: `true` when declared
 * true, `null` otherwise, with the reason stated. `externalSharingModel` is
 * declared in the source XML and never captured by the extractor — always
 * `null` + reason, never a silent absence.
 *
 * ── BOTH grant tiers name Profiles, not just the object tier ────────────────
 *
 * `permissions` carries two blocks: object-level CRUD and field-level grants.
 * The object block was split into Profile and PermissionSet axes; the field
 * block — the LARGER of the two by an order of magnitude — was left as one
 * ascending id list, and since every `PermissionSet:` id sorts ahead of every
 * `Profile:` id it named ZERO Profiles under the same note that claimed the two
 * were listed separately. Both blocks now carry per-kind counts, a named sample
 * of EACH kind and a per-list truncation flag with the true total.
 *
 * ── A refused cap is said plainly, and not re-prescribed ────────────────────
 *
 * When the byte budget cannot honour the caller's `maxRowsPerSection`, the note
 * says the raise was REFUSED and prescribes `includeSections` — with a concrete
 * call — instead of prescribing the knob that was just refused. Re-prescribing
 * it sent a caller round a loop that returned a byte-identical response.
 *
 * ── What this tool refuses to fake ──────────────────────────────────────────
 *
 * "When was the last record created", "who owns the most records", "who created
 * the most records", "how many records are there", "how many fields are
 * populated" and "is it still used recently" are RECORD DATA. The vault holds
 * METADATA. None is answerable offline at ANY confidence, so each surfaces in
 * `dataNotAvailable[]` naming the live tool that CAN answer it, rather than
 * being silently omitted or approximated from a proxy. This tool never calls
 * the live plane itself.
 *
 * Confidence is `mixed`: object properties, permission grants and relationship
 * declarations are `declared`; Apex-sourced usage edges are `parsed` or
 * `heuristic`.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  danglingTargetIdsMatching,
  getNodeById,
  listChildren,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  resolveComponents,
  searchNodes,
} from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsageDetail,
} from './report-dashboard-usage.js';

/** Canonical id prefix for the object this tool profiles. */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** Canonical id prefix for the child fields whose edges make up the field tier. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Default per-section row cap when the caller omits `maxRowsPerSection`. */
const DEFAULT_MAX_ROWS_PER_SECTION = 20;

/** Hard ceiling on `maxRowsPerSection` — this tool fans out badly by design. */
const MAX_ROWS_PER_SECTION_CAP = 100;

/** Chunk size for the referrer-node lookup, so one `IN (...)` never gets pathological. */
const REFERRER_LOOKUP_BATCH = 400;

/**
 * Window for the case-insensitive object lookup. `searchNodes` orders exact
 * then prefix matches first, so a case variant of the requested name is inside
 * this window on any realistic org; a miss falls through to `component-not-
 * found` WITH near-miss names rather than to a silently different object.
 */
const OBJECT_SEARCH_LIMIT = 50;

/**
 * Self-imposed serialized-byte ceiling, set BELOW the dispatcher's 40 000-byte
 * response budget so the headroom absorbs the transport envelope.
 *
 * The old tool blew that budget on the widest object at `maxRowsPerSection:
 * 100` (measured 40 164 bytes) — which is precisely the remedy its own
 * truncation note prescribed, so the documented escape hatch was broken exactly
 * where a caller would reach for it. This build adds sections, so the fit is
 * enforced rather than hoped for: assembly is a PURE function of already-fetched
 * data, and it is re-run at successively smaller row caps until the payload
 * fits. Every AGGREGATE is computed over the full set before any cap, so only
 * illustrative row lists shrink and each shrink is disclosed in `truncation[]`.
 *
 * Fitting is not the same as HONOURING. On the widest object the ladder bottoms
 * out below the requested cap, so `maxRowsPerSection: 100` returns the same
 * bytes as the default: it no longer errors, and it also does not work. That is
 * disclosed as a REFUSAL (`appliedScope.maxRowsPerSectionHonoured: false`) with
 * `includeSections` named as the remedy that has budget left — never by
 * re-prescribing the cap that was just refused.
 */
const BYTE_BUDGET = 36_000;

/**
 * The byte-fit ladder, in the order the passes are tried.
 *
 * Referrer SAMPLES shrink FIRST and the row cap only afterwards, because the
 * samples are illustrative (each group already states its exact
 * `referrers` / `edges` count and its `sampleTruncatedTotal`) while the row
 * lists carry the answers a caller asked for by name — which profiles can
 * create, which record types exist, which sharing rules apply. Absolute values,
 * not fractions, so the ladder always reaches 1: a fractional floor left the
 * widest object over budget with no step left. Every attempt is clamped to the
 * caller's own cap, so a small requested cap is never raised.
 */
const BYTE_FIT_STEPS: readonly { readonly cap: number; readonly sample: number }[] = [
  { cap: 100, sample: 3 },
  { cap: 100, sample: 2 },
  { cap: 100, sample: 1 },
  { cap: 35, sample: 1 },
  { cap: 20, sample: 1 },
  { cap: 10, sample: 1 },
  { cap: 5, sample: 1 },
  { cap: 3, sample: 1 },
  { cap: 1, sample: 1 },
];

/**
 * Edge types that are NOT usage: `parentOf` is structural containment (every
 * child carries one, so counting it would make every object look depended-on in
 * proportion to its own size) and `grantedBy` is ACCESS, not usage. Both tiers
 * are still REPORTED, in `owns` and `permissions` respectively.
 */
const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(['parentOf', 'grantedBy']);

/**
 * Edge types that mean "automation fires on this object". `triggersOn` is the
 * ONLY edge that reaches an ApexTrigger or a record-triggered Flow: neither
 * carries a `parentId`, so an object's automation is invisible to a child scan.
 */
const AUTOMATION_EDGE_TYPES: ReadonlySet<string> = new Set(['triggersOn']);

/** Child ComponentTypes that are themselves automation the object owns. */
const AUTOMATION_CHILD_TYPES: ReadonlySet<string> = new Set([
  'ValidationRule',
  'WorkflowRule',
  'ApprovalProcess',
  'DuplicateRule',
  'MatchingRule',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'WorkflowAlert',
  'WorkflowFieldUpdate',
]);

/** Child ComponentTypes that are UI surfaces the object owns. */
const UI_CHILD_TYPES: ReadonlySet<string> = new Set([
  'Layout',
  'CompactLayout',
  'ListView',
  'QuickAction',
  'WebLink',
  'FieldSet',
  'CustomTab',
  'PathAssistant',
  'BusinessProcess',
]);

/**
 * Object-level boolean properties the extractor writes as `false` when the
 * source XML simply does not DECLARE them. Measured on the probe vault: an
 * object whose XML declares none of these still gets four `false` values, and
 * `enableReports: false` was being read as "cannot be reported on" beside a
 * count of that object's report-referenced fields. `true` is trustworthy
 * (nothing invents a `true`); `false` is not, so `false` becomes `null`.
 */
const AMBIGUOUS_FALSE_OBJECT_FLAGS: readonly string[] = Object.freeze([
  'enableHistory',
  'enableReports',
  'enableActivities',
  'enableSearch',
]);

/** The content sections this tool implements — advertised verbatim in the roster. */
export const OBJECT_360_SECTIONS = [
  'identity',
  'brief',
  'owns',
  'usage',
  'automations',
  'permissions',
  'relationships',
  'recordTypes',
  'sharing',
  'recordPages',
  'analytics',
  'recordData',
] as const;

export type Object360Section = (typeof OBJECT_360_SECTIONS)[number];

/**
 * The RECORD-level questions this tool is asked and REFUSES to answer from
 * metadata. Emitted on EVERY response (they are unconditional — no refresh of
 * any org populates record data into the vault), each naming the live tool that
 * can answer it. Never conflate "the vault does not hold this" with "there is
 * none".
 *
 * The first two are byte-stable: hosts and tests quote them.
 */
const OBJECT_360_DATA_NOT_AVAILABLE: readonly string[] = Object.freeze([
  'field-population — HOW MANY of this object\'s fields actually hold data, and on what share of records, is RECORD DATA. The vault holds METADATA only, so no offline answer exists at any confidence. Use `sfi.unused_fields_deep` with `objectId` + `liveEnabled: true` (live plane, consented, capped at 3 fields per page) for the real population figures.',
  'record-recency — WHETHER this object is "still used recently" (last record created / modified, record volume trend) is RECORD DATA. Metadata `lastModifiedDate` on the object definition dates the last SCHEMA change, not the last record, and must never be read as activity. Use `sfi.live_count` (live plane, consented) for the record count.',
  'last-record-created / last-record-modified — WHEN the most recent record was created or edited is RECORD DATA. Use `sfi.live_recent_activity` (live plane, consented). A null in `recordData` means NOT CHECKED, never "no records".',
  'record-count — HOW MANY records exist is RECORD DATA. Use `sfi.live_count` (live plane, consented). Every count in this response counts METADATA components, never records.',
  'top-record-owner / top-record-creator — WHICH user owns or created the most records is RECORD DATA joined to the user table; neither side is in the offline vault. Use `sfi.live_owner_breakdown` (live plane, consented). A `CreatedById` reference counted in `usage` is a METADATA reference to the FIELD and says nothing about who created records.',
  'report-authorship — WHO created or owns the most reports is not answerable offline: the refresh never persists a report\'s author, owner or running user (real usernames, excluded by the analytics property allow-list). A PRIVACY boundary, not a refresh gap — no flag closes it. Report FOLDER is recoverable from the `Report:{Folder}/{Name}` id when Report nodes are persisted.',
  'last-used — "when was this object last used" is not in the vault: there is no login, record, report-run or API telemetry. Every date in this response is SCHEMA-shaped (`brief.lastMetadataChange`), never activity. For runtime signal use `sfi.live_recent_activity`.',
]);

/** Zod schema for the `sfi.object_360` tool input. */
export const object360InputSchema = z
  .object({
    /** Bare object api name (`Contact`) — the alias the router binds. */
    objectApiName: z.string().min(1).optional(),
    /** Canonical object id (`CustomObject:Contact`) — equivalent to `objectApiName`. */
    objectId: z.string().min(1).optional(),
    /** Canonical id alias a host reaches for. */
    componentId: z.string().min(1).optional(),
    /** Short alias the router's object family standardises on. */
    object: z.string().min(1).optional(),
    /** Narrow the response to a subset of sections (honesty surfaces always ship). */
    includeSections: z.array(z.enum(OBJECT_360_SECTIONS)).min(1).optional(),
    /** Per-section row cap (default 20, hard cap 100). */
    maxRowsPerSection: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROWS_PER_SECTION_CAP)
      .optional(),
  })
  .strict();

export type Object360Input = z.infer<typeof object360InputSchema>;

/** One referrer bucket: a ComponentType and how it reaches the object. */
export interface Object360ReferrerGroup {
  readonly referrerType: string;
  /** Distinct referrer NODES of this type (not edge rows). */
  readonly referrers: number;
  /** Edge rows of this type — always >= `referrers`. */
  readonly edges: number;
  readonly byEdgeType: Readonly<Record<string, number>>;
  /** Capped, sorted sample of referrer ids. */
  readonly sample: readonly string[];
  /** True total when `sample` was capped. */
  readonly sampleTruncatedTotal?: number;
}

/** One truncation disclosure — the section, the shown count, and the TRUE total. */
export interface Object360Truncation {
  readonly section: string;
  readonly shown: number;
  readonly total: number;
}

/** A tri-state metadata flag: declared value, or `null` with the reason stated. */
export interface Object360DeclaredFlag {
  readonly value: boolean | string | null;
  /** Present ONLY when `value` is null — why, and what would change it. */
  readonly unavailableReason?: string;
}

/** Sort helper — ids ascending, so every response is deterministic. */
const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Read a string property, mapping absent/blank/non-string to `null`. */
const stringProp = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const v = props[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/**
 * Read an object-level boolean flag as a TRI-STATE.
 *
 * The extractor cannot distinguish `<enableReports>false</enableReports>` from
 * an absent element — both persist as `false`. `true` is therefore the only
 * value that carries information; `false` collapses "declared off" with "never
 * declared" and must not be reported as a fact.
 */
const declaredFlag = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): Object360DeclaredFlag => {
  if (props[key] === true) return { value: true };
  return {
    value: null,
    unavailableReason:
      `\`${key}\` is not declared true in the retrieved metadata. The extractor writes \`false\` BOTH for a ` +
      `declared \`false\` AND for an element the XML never declares, so the two are indistinguishable here — ` +
      `reported as \`null\` (UNKNOWN), never as "the feature is off".`,
  };
};

/** Cap a sorted list and report the true total. */
const capList = (
  values: readonly string[],
  cap: number,
): { readonly shown: readonly string[]; readonly truncatedTotal?: number } => {
  const sorted = [...values].sort(byIdAsc);
  if (sorted.length <= cap) return { shown: sorted };
  return { shown: sorted.slice(0, cap), truncatedTotal: sorted.length };
};

/**
 * A truncation LEDGER. Every capped list in this response goes through it, so
 * `truncated` can never be `false` while a list was silently cut — the defect
 * where only two of the ~dozen capping sites reported themselves.
 */
interface Ledger {
  readonly rows: Object360Truncation[];
  /** Cap a string list, recording the cut. */
  readonly strings: (
    section: string,
    values: readonly string[],
    cap: number,
  ) => { readonly shown: readonly string[]; readonly truncatedTotal?: number };
  /** Cap an already-ordered row list, recording the cut. */
  readonly rowsOf: <T>(
    section: string,
    values: readonly T[],
    cap: number,
  ) => { readonly shown: readonly T[]; readonly truncatedTotal?: number };
}

const newLedger = (): Ledger => {
  const rows: Object360Truncation[] = [];
  const record = (section: string, shown: number, total: number): void => {
    rows.push({ section, shown, total });
  };
  return {
    rows,
    strings: (section, values, cap) => {
      const capped = capList(values, cap);
      if (capped.truncatedTotal !== undefined) {
        record(section, capped.shown.length, capped.truncatedTotal);
      }
      return capped;
    },
    rowsOf: <T,>(section: string, values: readonly T[], cap: number) => {
      if (values.length <= cap) return { shown: values };
      record(section, cap, values.length);
      return { shown: values.slice(0, cap), truncatedTotal: values.length };
    },
  };
};

/**
 * Group edges into per-referrer-type buckets. Counts DISTINCT referrer nodes
 * separately from edge rows, because one Flow writing five fields is one
 * dependency and five edges — reporting only the edge count is how an object
 * with a chatty Flow reads as more depended-on than one with fifty referrers.
 */
const groupByReferrerType = (
  ledger: Ledger,
  section: string,
  edges: readonly Edge[],
  typeOf: (id: ComponentId) => string,
  sampleCap: number,
): readonly Object360ReferrerGroup[] => {
  const buckets = new Map<
    string,
    { referrers: Set<string>; edges: number; byEdgeType: Map<string, number> }
  >();
  for (const edge of edges) {
    const referrerType = typeOf(edge.fromId);
    let bucket = buckets.get(referrerType);
    if (bucket === undefined) {
      bucket = { referrers: new Set(), edges: 0, byEdgeType: new Map() };
      buckets.set(referrerType, bucket);
    }
    bucket.referrers.add(edge.fromId);
    bucket.edges += 1;
    bucket.byEdgeType.set(edge.edgeType, (bucket.byEdgeType.get(edge.edgeType) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([referrerType, bucket]) => {
      const capped = ledger.strings(
        `${section}.${referrerType}`,
        [...bucket.referrers],
        sampleCap,
      );
      return {
        referrerType,
        referrers: bucket.referrers.size,
        edges: bucket.edges,
        byEdgeType: Object.fromEntries(
          [...bucket.byEdgeType.entries()].sort((a, b) => byIdAsc(a[0], b[0])),
        ),
        sample: capped.shown,
        ...(capped.truncatedTotal !== undefined
          ? { sampleTruncatedTotal: capped.truncatedTotal }
          : {}),
      };
    })
    .sort((a, b) => b.edges - a.edges || byIdAsc(a.referrerType, b.referrerType));
};

/** Tally edge rows by edge type, sorted for determinism. */
const tallyEdgeTypes = (edges: readonly Edge[]): Readonly<Record<string, number>> => {
  const out = new Map<string, number>();
  for (const edge of edges) out.set(edge.edgeType, (out.get(edge.edgeType) ?? 0) + 1);
  return Object.fromEntries([...out.entries()].sort((a, b) => byIdAsc(a[0], b[0])));
};

/**
 * Read a component's activation state without inventing one. Flows and Apex
 * carry `status`; rules carry `active` / `isActive`. A component whose family
 * stamps neither is `unknown` — never silently counted as active.
 */
const activationOf = (node: Node | undefined): 'active' | 'inactive' | 'unknown' => {
  if (node === undefined) return 'unknown';
  const props = node.properties;
  if (props['active'] === true || props['isActive'] === true) return 'active';
  if (props['active'] === false || props['isActive'] === false) return 'inactive';
  const status = stringProp(props, 'status');
  if (status === null) return 'unknown';
  return status === 'Active' ? 'active' : 'inactive';
};

/**
 * Resolve the caller's object selector to ONE canonical `CustomObject:` id.
 * Disagreeing selectors are `invalid-query` — never a silently-picked winner,
 * which is how a caller ends up reading an answer about a different object.
 */
const resolveObjectId = (input: Object360Input): Result<ComponentId, McpError> => {
  const raw = [input.componentId, input.objectId, input.objectApiName, input.object]
    .filter((v): v is string => v !== undefined && v.trim() !== '')
    .map((v) => coercePrefix(v.trim(), [CUSTOM_OBJECT_PREFIX]));
  if (raw.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'object_360 needs ONE object to profile. Pass `objectApiName` (e.g. "Contact") ' +
        'or the canonical `objectId` / `componentId` (e.g. "CustomObject:Contact"). ' +
        'No object was named, so nothing was checked — this is not a report that the org has no objects.',
    });
  }
  const distinct = [...new Set(raw)];
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `object selectors disagree: ${distinct.sort(byIdAsc).join(', ')}. Pass exactly one object.`,
    });
  }
  const id = distinct[0] as ComponentId;
  if (!id.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `object_360 profiles a CustomObject; \`${id}\` is not a \`CustomObject:\` id.`,
    });
  }
  return ok(id);
};

/**
 * Classify the object by PROVENANCE — locally created, standard, or shipped by
 * an installed package. This is descriptive metadata (it changes what a change
 * to the object even means), NOT a gate: this tool draws no conclusion from it
 * about what the reader may do.
 */
const classifyObjectKind = (
  apiName: string,
): { readonly kind: 'standard' | 'custom' | 'managed'; readonly namespace: string | null } => {
  const segments = apiName.split('__');
  if (
    apiName.endsWith('__c') ||
    apiName.endsWith('__mdt') ||
    apiName.endsWith('__e') ||
    apiName.endsWith('__b')
  ) {
    // `ns__Thing__c` splits to 3 segments; `Thing__c` to 2.
    if (segments.length >= 3) return { kind: 'managed', namespace: segments[0] ?? null };
    return { kind: 'custom', namespace: null };
  }
  return { kind: 'standard', namespace: null };
};

/**
 * The object segment of a `CustomField:<Object>.<Field>` id, case-folded.
 * Salesforce api names are case-insensitive and the vault holds case-variant
 * spellings of the same field (list-view column tokens upper-case them), so a
 * case-SENSITIVE match would drop real references to this object's fields.
 */
const fieldOwnerOf = (id: string): string | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const rest = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  return dot <= 0 ? null : rest.slice(0, dot).toLowerCase();
};

/** Availability of one metadata family, phrased so empty never reads as none. */
interface FamilyAvailability {
  readonly modeled: boolean;
  readonly note: string;
}

/**
 * Decide whether a metadata family is MODELED in this vault, and say what an
 * empty result means either way. Three states are kept apart: retrieved (an
 * empty list means "checked, none"), requested-but-empty/capped ("not
 * confirmed"), and absent from coverage entirely ("never modeled — not
 * checked").
 */
const familyAvailability = (
  ctx: Context,
  type: string,
  observed: number,
  emptyMeans: string,
  remedy: string,
): FamilyAvailability => {
  const coverage = summarizeCoverage(ctx.manifest, [type]);
  if (observed > 0) {
    return {
      modeled: true,
      note: `\`${type}\` is modeled in this vault and ${observed} row(s) were found for this object.`,
    };
  }
  if (!coverage.coverageKnown) {
    return {
      modeled: false,
      note:
        `this vault's manifest carries no coverage ledger, so whether \`${type}\` was retrieved at all cannot be ` +
        `determined. Read the empty result as NOT CHECKED, never as "${emptyMeans}". ${remedy}`,
    };
  }
  if (coverage.status === 'complete') {
    return {
      modeled: true,
      note: `\`${type}\` was retrieved by the last refresh and none is attached to this object — this empty result means "${emptyMeans}".`,
    };
  }
  /**
   * Three distinct absences, kept apart because they need different remedies:
   *   - no coverage ROW at all  -> the family has no extractor here; nothing was
   *     ever checked, and no refresh flag changes that until one ships.
   *   - `neverModeled`          -> the ledger says so explicitly.
   *   - requested but partial   -> retrieved zero / capped / errored.
   */
  const hasRow =
    coverage.coveredTypes.length > 0 ||
    coverage.partialTypes.length > 0 ||
    coverage.notModeledTypes.length > 0;
  if (!hasRow || coverage.notModeledTypes.includes(type)) {
    return {
      modeled: false,
      note:
        `\`${type}\` is NOT MODELED in this vault — no extractor produced it, so NOTHING was checked. This empty ` +
        `result must NOT be read as "${emptyMeans}". ${remedy}`,
    };
  }
  const missing = coverage.missingCoverage.length > 0 ? coverage.missingCoverage : [type];
  return {
    modeled: false,
    note:
      `\`${type}\` was requested but has incomplete coverage in this vault (${missing.join(', ')}), so this empty ` +
      `result is "not checked", NOT "${emptyMeans}". ${remedy}`,
  };
};

/** The graph reads this handler makes, gathered once and then rendered purely. */
interface Gathered {
  readonly objectNode: Node | null;
  readonly objectInbound: readonly Edge[];
  readonly children: readonly Node[];
  readonly fieldInboundAll: readonly Edge[];
  readonly fieldGrantEdges: readonly Edge[];
  readonly referencedDeclaredFieldIds: ReadonlySet<string>;
  readonly unresolvedFieldTargets: ReadonlySet<string>;
  readonly unresolvedFieldEdgeCount: number;
  /** Field ids (noded + un-noded) whose inbound edges were actually read. */
  readonly fieldTargetCount: number;
  readonly referrerById: ReadonlyMap<string, Node>;
}

/** Nothing landed at all: no node of its own, no inbound edge, no child. */
const isEmptyGather = (g: Gathered): boolean =>
  g.objectNode === null && g.objectInbound.length === 0 && g.children.length === 0;

/**
 * Case-INSENSITIVE object ids matching `apiName`.
 *
 * Salesforce api names are case-insensitive — `contact` and `Contact` name the
 * same object in SOQL, in a formula and in the Setup UI — so a caller who types
 * the lower-case form is not naming a different object, and answering
 * `component-not-found` told them the object does not exist. Resolution is
 * still EXPLICIT: the canonical id that was actually profiled is echoed in
 * `appliedScope`, and two ids differing only by case are `invalid-query` (a
 * silently-picked winner is how a reader ends up with an answer about the other
 * one). `searchNodes` is an indexed ILIKE, so this costs one query and only on
 * the miss path.
 */
const caseInsensitiveObjectIds = async (
  ctx: Context,
  apiName: string,
): Promise<Result<readonly ComponentId[], McpError>> => {
  const hits = await searchNodes(ctx.graph, apiName, {
    types: ['CustomObject'],
    limit: OBJECT_SEARCH_LIMIT,
  });
  if (!hits.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${hits.error.message}` });
  }
  const folded = apiName.toLowerCase();
  return ok(
    hits.value
      .map((h) => h.id)
      .filter((id) => id.slice(CUSTOM_OBJECT_PREFIX.length).toLowerCase() === folded)
      .sort(byIdAsc) as readonly ComponentId[],
  );
};

/**
 * Near-miss object names for a `component-not-found`, so a typo costs one retry
 * rather than a guess. NAMED, never auto-substituted — `sfi.apex_structure`
 * offers the same courtesy and this tool did not.
 *
 * Two gates, because the resolver always ranks SOMETHING and printing its best
 * guess for a name that resembles nothing dresses noise up as a suggestion:
 * `disposition: 'none'` emits NOTHING (measured on the probe vault, a name with
 * no relation to the org still returns five candidates scoring 0.67-0.77), and
 * within a real near-miss only candidates close to the BEST one survive, so a
 * single good match is not padded out to five. When neither gate passes the
 * message simply ends — the honest answer to "did you mean" when nothing is.
 */
const SUGGESTION_RELATIVE_FLOOR = 0.9;

const closestObjectSuggestion = async (ctx: Context, apiName: string): Promise<string> => {
  const fuzzy = await resolveComponents(ctx.graph, apiName, {
    types: ['CustomObject'],
    limit: 5,
  });
  if (!fuzzy.ok || fuzzy.value.disposition === 'none') return '';
  const best = Math.max(...fuzzy.value.candidates.map((c) => c.base), 0);
  const near = fuzzy.value.candidates.filter((c) => c.base >= best * SUGGESTION_RELATIVE_FLOOR);
  if (near.length === 0) return '';
  return ` Closest CustomObject names in this vault: ${near.map((c) => c.id).join(', ')}.`;
};

/**
 * Every graph read this tool makes for ONE object id. Split out of the handler
 * so a case-insensitive retry re-reads against the corrected id instead of
 * answering about the wrong one. Returns an EMPTY gather (and skips the
 * field-tier reads) when the id lands on nothing at all.
 */
const gatherFor = async (
  ctx: Context,
  objectId: ComponentId,
  apiName: string,
): Promise<Result<Gathered, McpError>> => {
  const nodeResult = await getNodeById(ctx.graph, objectId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  const objectNode = nodeResult.value;

  // Inbound edges to the object NODE. Read before the not-found decision: a
  // standard / managed object often has no node of its own but IS referenced,
  // and answering from those edges (phantom-aware) beats a not-found.
  const objectEdgesResult = await listEdges(ctx.graph, objectId, { direction: 'in' });
  if (!objectEdgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objectEdgesResult.error.message}` });
  }
  const objectInbound = objectEdgesResult.value;

  const childrenResult = await listChildren(ctx.graph, objectId);
  if (!childrenResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${childrenResult.error.message}` });
  }
  const children = childrenResult.value;

  if (objectNode === null && objectInbound.length === 0 && children.length === 0) {
    return ok({
      objectNode: null,
      objectInbound: [],
      children: [],
      fieldInboundAll: [],
      fieldGrantEdges: [],
      referencedDeclaredFieldIds: new Set<string>(),
      unresolvedFieldTargets: new Set<string>(),
      unresolvedFieldEdgeCount: 0,
      fieldTargetCount: 0,
      referrerById: new Map<string, Node>(),
    });
  }

  // ── Child census — by parentId, NOT by parentOf edge ─────────────────────
  const fieldChildren = children.filter((c) => c.type === 'CustomField');
  const declaredFieldIds = new Set(fieldChildren.map((c) => c.id as string));

  /**
   * The field tier's PHANTOM targets. `listChildren` finds only field ids that
   * have a node; an edge pointing at `CustomField:<Obj>.<X>` with no node
   * (platform/audit fields, list-view column tokens, case-variant spellings)
   * would be dropped entirely. `danglingTargetIdsMatching` is a deliberately
   * LOOSE substring pre-filter, so the authoritative owner test is applied on
   * top — and case-INSENSITIVELY, because the vault holds `CONTACT.EMAIL`
   * alongside `Contact.Email` and both are references to this object.
   */
  const danglingResult = await danglingTargetIdsMatching(
    ctx.graph,
    `${CUSTOM_FIELD_PREFIX}${apiName}.`,
  );
  if (!danglingResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${danglingResult.error.message}` });
  }
  const ownerKey = apiName.toLowerCase();
  const phantomFieldIds = danglingResult.value.filter(
    (id) => fieldOwnerOf(id) === ownerKey && !declaredFieldIds.has(id),
  );

  const fieldTargetIds = [...fieldChildren.map((c) => c.id), ...phantomFieldIds];
  const fieldEdgeResult =
    fieldTargetIds.length === 0
      ? ok(new Map<ComponentId, readonly Edge[]>())
      : await listEdgesForNodes(ctx.graph, fieldTargetIds, { direction: 'in' });
  if (!fieldEdgeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${fieldEdgeResult.error.message}` });
  }
  const phantomFieldIdSet = new Set<string>(phantomFieldIds);
  const fieldInboundAll: Edge[] = [];
  const fieldGrantEdges: Edge[] = [];
  const referencedDeclaredFieldIds = new Set<string>();
  const unresolvedFieldTargets = new Set<string>();
  let unresolvedFieldEdgeCount = 0;
  for (const [fieldId, edges] of fieldEdgeResult.value) {
    for (const edge of edges) {
      if (edge.edgeType === 'grantedBy') {
        fieldGrantEdges.push(edge);
        continue;
      }
      if (NON_USAGE_EDGE_TYPES.has(edge.edgeType)) continue;
      fieldInboundAll.push(edge);
      if (phantomFieldIdSet.has(fieldId)) {
        unresolvedFieldTargets.add(fieldId);
        unresolvedFieldEdgeCount += 1;
      } else {
        referencedDeclaredFieldIds.add(fieldId);
      }
    }
  }

  // Resolve every distinct referrer node ONCE so a bucket can be keyed by the
  // referrer's ComponentType rather than by an id-prefix guess.
  const referrerIds = [
    ...new Set([
      ...objectInbound.map((e) => e.fromId),
      ...fieldInboundAll.map((e) => e.fromId),
      ...fieldGrantEdges.map((e) => e.fromId),
    ]),
  ];
  const referrerById = new Map<string, Node>();
  for (let i = 0; i < referrerIds.length; i += REFERRER_LOOKUP_BATCH) {
    const batch = referrerIds.slice(i, i + REFERRER_LOOKUP_BATCH);
    const batchResult = await listNodesByIds(ctx.graph, batch);
    if (!batchResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${batchResult.error.message}` });
    }
    for (const n of batchResult.value) referrerById.set(n.id, n);
  }

  return ok({
    objectNode,
    objectInbound,
    children,
    fieldInboundAll,
    fieldGrantEdges,
    referencedDeclaredFieldIds,
    unresolvedFieldTargets,
    unresolvedFieldEdgeCount,
    fieldTargetCount: fieldTargetIds.length,
    referrerById,
  });
};

/**
 * Handler for `sfi.object_360`.
 */
export const object360Handler = async (
  ctx: Context,
  input: Object360Input,
): Promise<Result<McpResponse<Readonly<Record<string, unknown>>>, McpError>> => {
  const resolved = resolveObjectId(input);
  if (!resolved.ok) return err(resolved.error);
  const requestedId = resolved.value;
  const requestedApiName = requestedId.slice(CUSTOM_OBJECT_PREFIX.length);
  const requestedCap = input.maxRowsPerSection ?? DEFAULT_MAX_ROWS_PER_SECTION;
  const capWasExplicit = input.maxRowsPerSection !== undefined;
  const wanted: ReadonlySet<Object360Section> =
    input.includeSections === undefined
      ? new Set(OBJECT_360_SECTIONS)
      : new Set(input.includeSections);

  let objectId = requestedId;
  let apiName = requestedApiName;
  /** The id the caller passed, when it differed from the one profiled. */
  let resolvedFrom: string | null = null;

  const first = await gatherFor(ctx, objectId, apiName);
  if (!first.ok) return err(first.error);
  let gathered = first.value;

  // CASE-INSENSITIVE RETRY. Only on a total miss, so an exact id never pays for
  // it and an exactly-cased object is never re-pointed at a case variant.
  if (isEmptyGather(gathered)) {
    const variants = await caseInsensitiveObjectIds(ctx, requestedApiName);
    if (!variants.ok) return err(variants.error);
    const others = variants.value.filter((id) => id !== requestedId);
    if (others.length > 1) {
      return err({
        kind: 'invalid-query',
        message:
          `\`${requestedApiName}\` matches ${others.length} objects in this vault that differ only by CASE ` +
          `(${others.join(', ')}). Salesforce api names are case-insensitive, so nothing here can pick between ` +
          `them — pass the exact \`objectId\` you mean. Nothing was profiled.`,
      });
    }
    const only = others[0];
    if (only !== undefined) {
      const retry = await gatherFor(ctx, only, only.slice(CUSTOM_OBJECT_PREFIX.length));
      if (!retry.ok) return err(retry.error);
      if (!isEmptyGather(retry.value)) {
        resolvedFrom = requestedId;
        objectId = only;
        apiName = only.slice(CUSTOM_OBJECT_PREFIX.length);
        gathered = retry.value;
      }
    }
  }

  if (isEmptyGather(gathered)) {
    // `phantomAwareNotFoundMessage` takes a TYPE LABEL, not a sentence: passing
    // prose produced "no <whole sentence> ... with id <id>". It also ends
    // without punctuation, so the near-miss names need a sentence break of
    // their own or they read as part of the id.
    const missing = await phantomAwareNotFoundMessage(ctx, requestedId, 'CustomObject');
    const suggestion = await closestObjectSuggestion(ctx, requestedApiName);
    return err({
      kind: 'component-not-found',
      message: `${missing}${missing.endsWith('.') ? '' : '.'}${suggestion}`,
      path: requestedId,
    });
  }

  // ── Byte fit: render purely at descending caps until the payload fits ────
  const defaultSampleCap = Math.max(1, Math.floor(requestedCap / 4));
  const render = (cap: number, sample: number): McpResponse<Readonly<Record<string, unknown>>> =>
    renderResponse(ctx, objectId, apiName, wanted, gathered, {
      requestedCap,
      capWasExplicit,
      effectiveCap: cap,
      effectiveSampleCap: sample,
      resolvedFrom,
    });
  let rendered = render(requestedCap, defaultSampleCap);
  let bytes = Buffer.byteLength(JSON.stringify(rendered));
  if (bytes > BYTE_BUDGET) {
    let lastCap = requestedCap;
    let lastSample = defaultSampleCap;
    for (const step of BYTE_FIT_STEPS) {
      const cap = Math.min(requestedCap, step.cap);
      const sample = Math.min(defaultSampleCap, step.sample);
      if (cap >= lastCap && sample >= lastSample) continue;
      lastCap = cap;
      lastSample = sample;
      rendered = render(cap, sample);
      bytes = Buffer.byteLength(JSON.stringify(rendered));
      if (bytes <= BYTE_BUDGET) break;
    }
  }
  return ok(rendered);
};

/** The cap axes one render pass ran at, plus how the object id was resolved. */
interface RenderScope {
  /** What the caller asked for (or the default) — echoed in `appliedScope`. */
  readonly requestedCap: number;
  /** True when the caller PASSED `maxRowsPerSection`, so a refusal can say so. */
  readonly capWasExplicit: boolean;
  /** What the row lists actually used. */
  readonly effectiveCap: number;
  /** What the referrer samples actually used. */
  readonly effectiveSampleCap: number;
  /** The id the caller passed, when a case-insensitive retry corrected it. */
  readonly resolvedFrom: string | null;
}

/**
 * Assemble the response from already-fetched data. PURE — no graph access — so
 * the byte-fit pass can re-run it at a smaller `effectiveCap` without paying
 * for another round trip. `requestedCap` is echoed in `appliedScope` (it is what
 * the caller asked for); `effectiveCap` is what the row lists actually used, and
 * a gap between them is disclosed.
 */
const renderResponse = (
  ctx: Context,
  objectId: ComponentId,
  apiName: string,
  wanted: ReadonlySet<Object360Section>,
  g: Gathered,
  scope: RenderScope,
): McpResponse<Readonly<Record<string, unknown>>> => {
  const ledger = newLedger();
  const { requestedCap, effectiveCap, effectiveSampleCap } = scope;
  const cap = effectiveCap;
  /**
   * Per-GROUP sample cap, derived from the per-section cap rather than equal to
   * it. `usage` emits one group per referrer ComponentType, so a flat `cap` per
   * group multiplies out across ~25 groups on a wide object. Every AGGREGATE is
   * still computed over the full edge set; only the illustrative id lists shrink.
   */
  const sampleCap = Math.max(1, effectiveSampleCap);
  const retrieved = g.objectNode !== null;
  const props = g.objectNode?.properties ?? {};
  const objectKind = classifyObjectKind(apiName);

  const childCounts = new Map<string, number>();
  for (const child of g.children) {
    childCounts.set(child.type, (childCounts.get(child.type) ?? 0) + 1);
  }
  const fieldChildren = g.children.filter((c) => c.type === 'CustomField');
  const syntheticFields = fieldChildren.filter((c) => c.properties['synthetic'] === true);
  const declaredFields = fieldChildren.filter((c) => c.properties['synthetic'] !== true);

  const objectUsageEdges = g.objectInbound.filter((e) => !NON_USAGE_EDGE_TYPES.has(e.edgeType));
  const objectGrantEdges = g.objectInbound.filter((e) => e.edgeType === 'grantedBy');

  const typeOf = (id: ComponentId): string => {
    const node = g.referrerById.get(id);
    if (node !== undefined) return node.type;
    const colon = id.indexOf(':');
    return colon > 0 ? id.slice(0, colon) : 'unknown';
  };

  /**
   * Distinct referrer NODES of one ComponentType across BOTH tiers, de-duplicated.
   * A class that reads the object AND three of its fields is ONE referencing
   * class; summing the two tiers' per-type counts would say four.
   */
  const distinctReferrersOfType = (type: string): number => {
    const seen = new Set<string>();
    for (const e of objectUsageEdges) if (typeOf(e.fromId) === type) seen.add(e.fromId);
    for (const e of g.fieldInboundAll) if (typeOf(e.fromId) === type) seen.add(e.fromId);
    return seen.size;
  };

  const objectDistinctReferrers = new Set(objectUsageEdges.map((e) => e.fromId));
  const fieldDistinctReferrers = new Set(g.fieldInboundAll.map((e) => e.fromId));
  const combinedReferrers = new Set([...objectDistinctReferrers, ...fieldDistinctReferrers]);

  // ── usage: the tier that points AT the object from OUTSIDE ───────────────
  const unresolvedNote =
    g.fieldInboundAll.length === 0
      ? `No edge reaches any field of this object, and no un-noded \`${CUSTOM_FIELD_PREFIX}${apiName}.*\` target ` +
        `exists either — so there was nothing to resolve. This is a CHECKED zero for the field tier` +
        (fieldChildren.length === 0
          ? ', but note this vault holds NO field node for this object at all, so the check had no declared fields to look at.'
          : '.')
      : g.unresolvedFieldTargets.size === 0
        ? `All ${g.fieldInboundAll.length} field-tier edge(s) resolved to a declared field node on this object; ` +
          `none was dropped.`
        : `${g.unresolvedFieldEdgeCount} of the ${g.fieldInboundAll.length} field-tier edge(s) point at ` +
        `${g.unresolvedFieldTargets.size} field id(s) with NO node here — platform/audit fields (\`Name\`, \`Id\`, ` +
        `\`OwnerId\`, \`CreatedById\`), list-view column tokens (\`FULL_NAME\`), or case-variant spellings. They ARE ` +
        `counted in the edge totals (dropping them under-counted this tier by ~20% org-wide on the probe vault) ` +
        `but NOT in \`declaredFieldsReferenced\`; a case variant may name a declared field, so \`unresolvedTargets\` ` +
        `bounds distinct extra FIELDS, not edges.`;

  const tierNote =
    `Object-level usage (${objectUsageEdges.length} edge(s), ${objectDistinctReferrers.size} distinct referrer(s)) is ` +
    `only part of the surface pointing at this object: its ${fieldChildren.length} field node(s) plus ` +
    `${g.unresolvedFieldTargets.size} unresolved field target(s) carry a FURTHER ${g.fieldInboundAll.length} inbound ` +
    `usage edge(s) from ${fieldDistinctReferrers.size} distinct referrer(s). ` +
    `\`combined.distinctReferrers\` (${combinedReferrers.size}) de-duplicates a referrer reaching both tiers. ` +
    `Access grants (${objectGrantEdges.length} object + ${g.fieldGrantEdges.length} field-level) and containment ` +
    `are excluded from BOTH tiers — see \`permissions\` / \`owns\`. This is an ACCOUNTING of references, not a ` +
    `judgement.` +
    (retrieved
      ? ''
      : ` NOTE: this object has no node of its own in this vault, so the field counts above are the field NODES ` +
        `this vault happens to hold (${fieldChildren.length}), not this object's real schema.`);

  const usageSection = {
    framing: 'OUTSIDE the object, pointing AT it — these do not travel with it. What it CONTAINS is in `owns`.',
    objectLevel: {
      edges: objectUsageEdges.length,
      distinctReferrers: objectDistinctReferrers.size,
      byEdgeType: tallyEdgeTypes(objectUsageEdges),
      byReferrerType: groupByReferrerType(
        ledger,
        'usage.objectLevel.byReferrerType',
        objectUsageEdges,
        typeOf,
        sampleCap,
      ),
    },
    fieldLevel: {
      edges: g.fieldInboundAll.length,
      distinctReferrers: fieldDistinctReferrers.size,
      declaredFieldsReferenced: g.referencedDeclaredFieldIds.size,
      declaredFieldsTotal: fieldChildren.length,
      unresolvedTargets: g.unresolvedFieldTargets.size,
      unresolvedTargetEdges: g.unresolvedFieldEdgeCount,
      unresolvedTargetsSample: ledger.strings(
        'usage.fieldLevel.unresolvedTargetsSample',
        [...g.unresolvedFieldTargets],
        sampleCap,
      ).shown,
      unresolvedNote,
      byEdgeType: tallyEdgeTypes(g.fieldInboundAll),
      byReferrerType: groupByReferrerType(
        ledger,
        'usage.fieldLevel.byReferrerType',
        g.fieldInboundAll,
        typeOf,
        sampleCap,
      ),
    },
    combined: {
      distinctReferrers: combinedReferrers.size,
      objectLevelShareOfEdges:
        objectUsageEdges.length + g.fieldInboundAll.length === 0
          ? null
          : Math.round(
              (objectUsageEdges.length / (objectUsageEdges.length + g.fieldInboundAll.length)) * 1000,
            ) / 1000,
    },
    tierNote,
  };

  // ── owns: what CONTAINS, i.e. what goes with the object ──────────────────
  const ownedRows = [...childCounts.entries()]
    .map(([type, count]) => ({
      type,
      count,
      role: AUTOMATION_CHILD_TYPES.has(type)
        ? 'automation'
        : UI_CHILD_TYPES.has(type)
          ? 'ui'
          : type === 'CustomField'
            ? 'schema'
            : type === 'RecordType'
              ? 'schema'
              : type === 'SharingRule' || type === 'RestrictionRule'
                ? 'sharing'
                : 'other',
      examples: ledger.strings(
        `owns.byType.${type}`,
        g.children.filter((c) => c.type === type).map((c) => c.id),
        sampleCap,
      ).shown,
    }))
    .sort((a, b) => b.count - a.count || byIdAsc(a.type, b.type));

  const ownsSection = {
    framing: 'CONTAINED by the object and travelling with it — containment, not dependency. What points AT it is in `usage`.',
    totalComponents: g.children.length,
    byType: Object.fromEntries(
      [...childCounts.entries()].sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
    ),
    detail: ownedRows,
    enumerationNote:
      'Enumerated by `parentId`, NOT by `parentOf` edge: `parentOf` is not minted for every family (ListView and ' +
      'Role carry a parentId and ZERO parentOf edges), so an edge walk drops every list view an object owns.',
  };

  // ── automations ──────────────────────────────────────────────────────────
  const automationEdges = g.objectInbound.filter((e) => AUTOMATION_EDGE_TYPES.has(e.edgeType));
  const boundIds = [...new Set(automationEdges.map((e) => e.fromId))];
  const boundByType = new Map<string, string[]>();
  for (const id of boundIds) {
    const t = typeOf(id as ComponentId);
    boundByType.set(t, [...(boundByType.get(t) ?? []), id]);
  }
  const activationTally = (
    ids: readonly string[],
  ): { active: number; inactive: number; unknown: number } => {
    const out = { active: 0, inactive: 0, unknown: 0 };
    for (const id of ids) out[activationOf(g.referrerById.get(id))] += 1;
    return out;
  };
  const firesOnSave = [...boundByType.entries()]
    .map(([referrerType, ids]) => {
      const tally = activationTally(ids);
      const capped = ledger.strings(`automations.firesOnSave.${referrerType}`, ids, cap);
      return {
        referrerType,
        count: ids.length,
        active: tally.active,
        inactive: tally.inactive,
        activationUnknown: tally.unknown,
        components: capped.shown.map((id) => ({
          id,
          activation: activationOf(g.referrerById.get(id)),
        })),
        ...(capped.truncatedTotal !== undefined ? { truncatedTotal: capped.truncatedTotal } : {}),
      };
    })
    .sort((a, b) => b.count - a.count || byIdAsc(a.referrerType, b.referrerType));

  const ownedAutomationChildren = g.children.filter((c) => AUTOMATION_CHILD_TYPES.has(c.type));
  const ownedAutomation = [...new Set(ownedAutomationChildren.map((c) => c.type))]
    .map((type) => {
      const members = ownedAutomationChildren.filter((c) => c.type === type);
      const out = { active: 0, inactive: 0, unknown: 0 };
      for (const m of members) out[activationOf(m)] += 1;
      return {
        type,
        count: members.length,
        active: out.active,
        inactive: out.inactive,
        activationUnknown: out.unknown,
        examples: ledger.strings(
          `automations.ownedAutomation.${type}`,
          members.map((m) => m.id),
          sampleCap,
        ).shown,
      };
    })
    .sort((a, b) => b.count - a.count || byIdAsc(a.type, b.type));

  const activeBound = firesOnSave.reduce((s, r) => s + r.active, 0);
  const automationsSection = {
    firesOnSave,
    activeBoundToObject: activeBound,
    inactiveBoundToObject: firesOnSave.reduce((s, r) => s + r.inactive, 0),
    firesOnSaveNote:
      'Record-triggered Flows and ApexTriggers carry NO `parentId`; the `triggersOn` edge is the only link, so ' +
      'this is invisible to a child scan. `activation` reads the component\'s declared `status` / `active`; ' +
      '`unknown` means the family stamps neither and was NOT assumed active. Bindings are LISTED, not evaluated ' +
      '(entry criteria are not run). Ordered save sequence: `sfi.what_happens_on_save`.',
    ownedAutomation,
    fieldWriters: groupByReferrerType(
      ledger,
      'automations.fieldWriters',
      g.fieldInboundAll.filter((e) => e.edgeType === 'writesTo'),
      typeOf,
      sampleCap,
    ),
    fieldWritersNote:
      'Components that WRITE to this object\'s fields — missed entirely by a `triggersOn`-only view (a Flow on a ' +
      'DIFFERENT object updating this one is `writesTo`, never `triggersOn`).',
  };

  // ── permissions: how many profiles can CREATE, how many can EDIT ─────────
  const crudKeys = ['allowCreate', 'allowRead', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords'] as const;
  const granterBuckets = new Map<string, Map<string, Edge>>();
  for (const edge of objectGrantEdges) {
    const t = typeOf(edge.fromId);
    const bucket = granterBuckets.get(t) ?? new Map<string, Edge>();
    bucket.set(edge.fromId, edge);
    granterBuckets.set(t, bucket);
  }
  const buildCrud = (
    granterType: string,
    grants: ReadonlyMap<string, Edge>,
  ): Record<string, unknown> => {
    const counts: Record<string, number> = {};
    const named: Record<string, readonly string[]> = {};
    let undeclared = 0;
    for (const key of crudKeys) {
      const holders = [...grants.entries()]
        .filter(([, e]) => e.properties[key] === true)
        .map(([id]) => id);
      counts[key] = holders.length;
      const capped = ledger.strings(`permissions.objectCrud.${granterType}.${key}`, holders, cap);
      named[key] = capped.shown;
    }
    for (const [, e] of grants) {
      if (crudKeys.every((k) => typeof e.properties[k] !== 'boolean')) undeclared += 1;
    }
    return {
      granters: grants.size,
      canCreate: counts['allowCreate'] ?? 0,
      canRead: counts['allowRead'] ?? 0,
      canEdit: counts['allowEdit'] ?? 0,
      canDelete: counts['allowDelete'] ?? 0,
      viewAllRecords: counts['viewAllRecords'] ?? 0,
      modifyAllRecords: counts['modifyAllRecords'] ?? 0,
      grantersWithNoDeclaredCrud: undeclared,
      names: named,
    };
  };
  const profileGrants = granterBuckets.get('Profile') ?? new Map<string, Edge>();
  const permsetGrants = granterBuckets.get('PermissionSet') ?? new Map<string, Edge>();
  const otherGranterTypes = [...granterBuckets.entries()]
    .filter(([t]) => t !== 'Profile' && t !== 'PermissionSet')
    .map(([t, m]) => ({ granterType: t, granters: m.size }))
    .sort((a, b) => b.granters - a.granters || byIdAsc(a.granterType, b.granterType));

  const fieldGranters = new Set(g.fieldGrantEdges.map((e) => e.fromId));

  /**
   * FIELD-level grants, split on the SAME two axes as `objectCrud` above.
   *
   * This block used to be ONE ascending id array. Every `PermissionSet:` id
   * sorts ahead of every `Profile:` id, so the cap was spent entirely on
   * permission sets and the response named ZERO Profiles — inside the very
   * block whose note claimed the two were "listed SEPARATELY". Measured on the
   * probe vault's widest object: 82 distinct field-level granters, 52 of them
   * Profiles, none named by a default call, in the LARGER of the two grant
   * tiers (14 657 edges against 82 object-level ones). "Which profiles will be
   * affected" is the question this tool exists to answer, so the field tier
   * gets what the object tier already had: per-kind distinct counts, a named
   * sample of EACH kind, and a per-list truncation flag carrying the TRUE total.
   */
  interface FieldGrantBucket {
    readonly ids: Set<string>;
    edges: number;
    readonly readable: Set<string>;
    readonly editable: Set<string>;
  }
  const fieldGrantsByKind = new Map<string, FieldGrantBucket>();
  for (const e of g.fieldGrantEdges) {
    const t = typeOf(e.fromId);
    let bucket = fieldGrantsByKind.get(t);
    if (bucket === undefined) {
      bucket = { ids: new Set(), edges: 0, readable: new Set(), editable: new Set() };
      fieldGrantsByKind.set(t, bucket);
    }
    bucket.ids.add(e.fromId);
    bucket.edges += 1;
    if (e.properties['readable'] === true) bucket.readable.add(e.fromId);
    if (e.properties['editable'] === true) bucket.editable.add(e.fromId);
  }
  const buildFieldGrantKind = (
    kindKey: string,
    granterType: string,
  ): Record<string, unknown> => {
    const bucket = fieldGrantsByKind.get(granterType);
    const ids = [...(bucket?.ids ?? [])];
    const capped = ledger.strings(`permissions.fieldLevelGrants.${kindKey}`, ids, cap);
    return {
      granters: ids.length,
      edges: bucket?.edges ?? 0,
      canReadSomeField: bucket?.readable.size ?? 0,
      canEditSomeField: bucket?.editable.size ?? 0,
      names: capped.shown,
      namesTruncated: capped.truncatedTotal !== undefined,
      ...(capped.truncatedTotal !== undefined ? { namesTotal: capped.truncatedTotal } : {}),
    };
  };
  const otherFieldGranterTypes = [...fieldGrantsByKind.entries()]
    .filter(([t]) => t !== 'Profile' && t !== 'PermissionSet')
    .map(([t, b]) => ({ granterType: t, granters: b.ids.size, edges: b.edges }))
    .sort((a, b) => b.granters - a.granters || byIdAsc(a.granterType, b.granterType));
  const fieldGrantProfileCount = fieldGrantsByKind.get('Profile')?.ids.size ?? 0;
  const fieldGrantPermsetCount = fieldGrantsByKind.get('PermissionSet')?.ids.size ?? 0;

  const permissionsSection = {
    objectCrud: {
      profiles: buildCrud('profiles', profileGrants),
      permissionSets: buildCrud('permissionSets', permsetGrants),
      ...(otherGranterTypes.length > 0 ? { otherGranterTypes } : {}),
    },
    fieldLevelGrants: {
      edges: g.fieldGrantEdges.length,
      distinctGranters: fieldGranters.size,
      profiles: buildFieldGrantKind('profiles', 'Profile'),
      permissionSets: buildFieldGrantKind('permissionSets', 'PermissionSet'),
      ...(otherFieldGranterTypes.length > 0
        ? { otherGranterTypes: otherFieldGranterTypes }
        : {}),
      note:
        `${fieldGrantProfileCount} Profile(s) and ${fieldGrantPermsetCount} PermissionSet(s) declare a FIELD ` +
        `permission on a field of \`${apiName}\`, on SEPARATE axes for the same reason \`objectCrud\` is: a ` +
        `single ascending id list spends its whole cap on \`PermissionSet:\` (every one sorts ahead of every ` +
        `\`Profile:\`) and names zero Profiles on exactly the object that has the most of them. ` +
        `\`canReadSomeField\` / \`canEditSomeField\` count GRANTERS holding that verb on AT LEAST ONE field — ` +
        `never fields, and never users. The extractor emits an edge only where \`readable\` or \`editable\` is ` +
        `true, so a granter absent here declares NO field permission on this object; it is not one that was ` +
        `denied. ` +
        (g.fieldTargetCount === 0
          ? `NOTHING WAS CHECKED: this vault holds no field id for this object at all, so read every zero above ` +
            `as NOT CHECKED, never as "no one has field access".`
          : `Both zeros are CHECKED: every \`grantedBy\` edge landing on the ${g.fieldTargetCount} field id(s) ` +
            `this vault holds for the object was read.`),
    },
    note:
      `${profileGrants.size} Profile(s) and ${permsetGrants.size} PermissionSet(s) declare an object permission on ` +
      `\`${apiName}\`, and ${fieldGrantProfileCount} / ${fieldGrantPermsetCount} respectively declare a ` +
      `field-level one. BOTH blocks list the two kinds SEPARATELY, so a shared ascending id list cannot drop ` +
      `every Profile behind the \`PermissionSet:\` prefix. These are CONTAINERS, not users — the assignment ` +
      `roster is not in the offline vault, so no count here is a headcount (\`sfi.live_permset_holders\` answers ` +
      `that live). PermissionSetGroup-conferred access is NOT expanded here: \`sfi.object_access_audit\` does that.`,
  };

  // ── relationships: related objects, both directions ──────────────────────
  const outboundRelationshipFields = fieldChildren
    .map((f) => ({
      fieldId: f.id,
      referenceTo: stringProp(f.properties, 'referenceTo'),
      relationshipName: stringProp(f.properties, 'relationshipName'),
      dataType: stringProp(f.properties, 'dataType'),
    }))
    .filter((r) => r.referenceTo !== null)
    .sort((a, b) => byIdAsc(a.fieldId, b.fieldId));
  const outboundTargets = new Map<string, number>();
  for (const r of outboundRelationshipFields) {
    outboundTargets.set(r.referenceTo as string, (outboundTargets.get(r.referenceTo as string) ?? 0) + 1);
  }

  const inboundLookupEdges = g.objectInbound.filter((e) => e.edgeType === 'lookupTo');
  const inboundRelationships = inboundLookupEdges
    .map((e) => ({
      fieldId: e.fromId,
      fromObject: (fieldOwnerOf(e.fromId) === null
        ? null
        : e.fromId.slice(CUSTOM_FIELD_PREFIX.length).split('.')[0]) as string | null,
      relationshipType: stringProp(e.properties, 'relationshipType'),
      relationshipName: stringProp(
        g.referrerById.get(e.fromId)?.properties ?? {},
        'relationshipName',
      ),
      targetMissing: e.properties['targetMissing'] === true,
    }))
    .sort((a, b) => byIdAsc(a.fieldId, b.fieldId));
  const inboundObjects = new Map<string, number>();
  for (const r of inboundRelationships) {
    if (r.fromObject === null) continue;
    inboundObjects.set(r.fromObject, (inboundObjects.get(r.fromObject) ?? 0) + 1);
  }

  // Formula fields on OTHER objects that resolve to a field on this one.
  const formulaEdges = g.fieldInboundAll.filter(
    (e) => e.source === 'formula-tokenizer' && e.fromId.startsWith(CUSTOM_FIELD_PREFIX),
  );
  const externalFormulaEdges = formulaEdges.filter((e) => fieldOwnerOf(e.fromId) !== apiName.toLowerCase());
  const externalFormulaFields = new Set(externalFormulaEdges.map((e) => e.fromId));
  const internalFormulaFields = new Set(
    formulaEdges.filter((e) => fieldOwnerOf(e.fromId) === apiName.toLowerCase()).map((e) => e.fromId),
  );
  const ownFormulaFieldsWithTraversal = fieldChildren.filter((f) => {
    const formula = stringProp(f.properties, 'formula');
    return formula !== null && formula.includes('__r.');
  }).length;

  const relationshipsSection = {
    toOtherObjects: {
      relationshipFields: outboundRelationshipFields.length,
      distinctTargets: outboundTargets.size,
      targets: Object.fromEntries(
        [...outboundTargets.entries()].sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      fields: ledger.rowsOf('relationships.toOtherObjects.fields', outboundRelationshipFields, cap)
        .shown,
      note:
        'Read from each field\'s DECLARED `referenceTo` / `relationshipName`, so a relationship whose target ' +
        'object was never retrieved is still listed (`declared` confidence).',
    },
    fromOtherObjects: {
      relationshipFields: inboundRelationships.length,
      distinctObjects: inboundObjects.size,
      objects: Object.fromEntries(
        [...inboundObjects.entries()].sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      masterDetail: inboundRelationships.filter((r) => r.relationshipType === 'MasterDetail').length,
      lookup: inboundRelationships.filter((r) => r.relationshipType === 'Lookup').length,
      fields: ledger.rowsOf('relationships.fromOtherObjects.fields', inboundRelationships, cap).shown,
      note:
        'Fields on OTHER objects pointing at this one. `MasterDetail` is the relationship Salesforce cascades on — ' +
        'a fact about the type, not advice. `targetMissing: true` means the edge names this object but its ' +
        'definition was not retrieved.',
    },
    usedInFormulaFields: {
      onOtherObjects: externalFormulaFields.size,
      onOtherObjectsEdges: externalFormulaEdges.length,
      onThisObject: internalFormulaFields.size,
      fields: ledger.strings(
        'relationships.usedInFormulaFields.fields',
        [...externalFormulaFields],
        cap,
      ).shown,
      ownFormulaFieldsWithCrossObjectTraversal: ownFormulaFieldsWithTraversal,
      boundaryNote:
        'Only formula references the vault RESOLVED into an edge (`source: formula-tokenizer`) are counted. A ' +
        'CROSS-OBJECT traversal written `Relationship__r.Field__c` is NOT resolved: measured on the probe vault, ' +
        '204 formula fields carry a `__r.` traversal and emit ZERO edges for it. So `onOtherObjects: 0` means "no ' +
        'RESOLVED cross-object formula reference", NEVER "no formula elsewhere reads this object". The ' +
        'relationships such a formula would travel are in `fromOtherObjects`; check them with ' +
        '`sfi.find_formula_references`.',
    },
  };

  // ── record types ─────────────────────────────────────────────────────────
  const recordTypeChildren = g.children.filter((c) => c.type === 'RecordType');
  const recordTypeRows = recordTypeChildren
    .map((rt) => ({
      id: rt.id,
      label: rt.label ?? stringProp(rt.properties, 'label'),
      active: rt.properties['active'] === true ? true : rt.properties['active'] === false ? false : null,
      businessProcess: stringProp(rt.properties, 'businessProcess'),
    }))
    .sort((a, b) => byIdAsc(a.id, b.id));
  const rtAvailability = familyAvailability(
    ctx,
    'RecordType',
    recordTypeChildren.length,
    'this object has no record types',
    'Re-run `/sfi-refresh` to retrieve them.',
  );
  const recordTypesSection = {
    total: recordTypeChildren.length,
    active: recordTypeRows.filter((r) => r.active === true).length,
    inactive: recordTypeRows.filter((r) => r.active === false).length,
    activationUnknown: recordTypeRows.filter((r) => r.active === null).length,
    recordTypes: ledger.rowsOf('recordTypes.recordTypes', recordTypeRows, cap).shown,
    availability: rtAvailability,
    note: 'Enumerated as CHILDREN (`parentId`). Who can SEE or DEFAULT to each: `sfi.recordtype_availability`.',
  };

  // ── sharing: OWD, sharing rules, sharing sets ────────────────────────────
  const sharingRuleChildren = g.children.filter((c) => c.type === 'SharingRule');
  const sharingRuleRows = sharingRuleChildren
    .map((r) => ({
      id: r.id,
      ruleType: stringProp(r.properties, 'ruleType'),
      accessLevel: stringProp(r.properties, 'accessLevel'),
      sharedToType: stringProp(r.properties, 'sharedToType'),
      sharedToName: stringProp(r.properties, 'sharedToName'),
    }))
    .sort((a, b) => byIdAsc(a.id, b.id));
  const sharingRuleAvailability = familyAvailability(
    ctx,
    'SharingRule',
    sharingRuleChildren.length,
    'this object has no sharing rules',
    'Re-run `/sfi-refresh` to retrieve them.',
  );

  /**
   * `SharingSet` may or may not be an extracted family in a given vault. Look
   * for it BOTH as a child and as an inbound referrer, and when neither turns up
   * say "not modeled" rather than emitting an empty list that reads as "none".
   */
  const sharingSetChildren = g.children.filter((c) => c.type === 'SharingSet');
  const sharingSetReferrers = [
    ...new Set(
      [...g.objectInbound, ...g.fieldInboundAll]
        .filter((e) => typeOf(e.fromId) === 'SharingSet' || e.fromId.startsWith('SharingSet:'))
        .map((e) => e.fromId),
    ),
  ];
  const sharingSetIds = [
    ...new Set([...sharingSetChildren.map((c) => c.id as string), ...sharingSetReferrers]),
  ].sort(byIdAsc);
  const sharingSetAvailability = familyAvailability(
    ctx,
    'SharingSet',
    sharingSetIds.length,
    'this object is in no sharing set',
    'A sharing set grants Experience Cloud users record access through a lookup; if this org uses one, it is invisible here until the family is extracted.',
  );

  const restrictionRuleChildren = g.children.filter((c) => c.type === 'RestrictionRule');
  const sharingSection = {
    orgWideDefault: {
      internal: stringProp(props, 'sharingModel'),
      external: {
        value: null,
        unavailableReason:
          '`externalSharingModel` IS declared in the object\'s source XML but the extractor never captures it, so ' +
          'it is absent from every object node here. NOT EXTRACTED — never read this null as Public or Private.',
      } satisfies Object360DeclaredFlag,
    },
    sharingRules: {
      total: sharingRuleChildren.length,
      byAccessLevel: Object.fromEntries(
        [...sharingRuleRows.reduce((m, r) => m.set(r.accessLevel ?? 'unknown', (m.get(r.accessLevel ?? 'unknown') ?? 0) + 1), new Map<string, number>())]
          .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      byRuleType: Object.fromEntries(
        [...sharingRuleRows.reduce((m, r) => m.set(r.ruleType ?? 'unknown', (m.get(r.ruleType ?? 'unknown') ?? 0) + 1), new Map<string, number>())]
          .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      rules: ledger.rowsOf('sharing.sharingRules.rules', sharingRuleRows, cap).shown,
      availability: sharingRuleAvailability,
    },
    sharingSets: {
      modeled: sharingSetAvailability.modeled,
      total: sharingSetIds.length,
      sharingSets: ledger.strings('sharing.sharingSets.sharingSets', sharingSetIds, cap).shown,
      availability: sharingSetAvailability,
    },
    restrictionRules: {
      total: restrictionRuleChildren.length,
      rules: ledger.strings(
        'sharing.restrictionRules.rules',
        restrictionRuleChildren.map((c) => c.id),
        cap,
      ).shown,
    },
    note:
      'Sharing and restriction rules are CHILDREN and travel with the object. Manual shares, account teams and ' +
      'territory assignment are RECORD-level, not metadata, and absent here at any confidence.',
  };

  // ── record pages: Lightning pages + Experience/community surfaces ────────
  const flexiPageEdges = g.objectInbound.filter((e) => typeOf(e.fromId) === 'FlexiPage');
  const flexiPageIds = [...new Set(flexiPageEdges.map((e) => e.fromId))].sort(byIdAsc);
  const flexiPageRows = flexiPageIds.map((id) => {
    const node = g.referrerById.get(id);
    const pageType = stringProp(node?.properties ?? {}, 'pageType');
    return {
      id,
      pageType,
      community: pageType !== null && pageType.startsWith('Comm'),
    };
  });
  const communityPages = flexiPageRows.filter((r) => r.community);
  const layoutChildren = g.children.filter((c) => c.type === 'Layout');
  const networkAvailability = familyAvailability(
    ctx,
    'Network',
    0,
    'this object appears on no community page',
    'Experience Cloud sites (`Network` / `ExperienceBundle`) are not an extracted family here, so WHICH site a page belongs to, and whether the site is active, cannot be determined offline.',
  );
  const recordPagesSection = {
    lightningRecordPages: {
      total: flexiPageRows.length,
      byPageType: Object.fromEntries(
        [...flexiPageRows.reduce((m, r) => m.set(r.pageType ?? 'unknown', (m.get(r.pageType ?? 'unknown') ?? 0) + 1), new Map<string, number>())]
          .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      pages: ledger.rowsOf('recordPages.lightningRecordPages.pages', flexiPageRows, cap).shown,
      note:
        'FlexiPages that REFERENCE this object. Not children, so they survive it and are counted in `usage`. Page ' +
        'ACTIVATIONS (app / profile / form factor) are not modeled here — a listed page is not proof users see it; ' +
        'see `sfi.lightning_pages`.',
    },
    communityRecordPages: {
      total: communityPages.length,
      pages: ledger.rowsOf('recordPages.communityRecordPages.pages', communityPages, cap).shown,
      experienceSiteModeling: networkAvailability,
      note:
        'A community record page is a FlexiPage whose `pageType` starts with `Comm`. Zero means no `Comm*` ' +
        'FlexiPage here references the object — read it WITH `experienceSiteModeling`, since the site layer ' +
        'itself is not extracted.',
    },
    classicLayouts: {
      total: layoutChildren.length,
      layouts: ledger.strings(
        'recordPages.classicLayouts.layouts',
        layoutChildren.map((c) => c.id),
        cap,
      ).shown,
      note: 'Layouts are CHILDREN and travel with the object. Which profile sees which layout: `sfi.layout_assignments`.',
    },
  };

  // ── analytics: reports, dashboards, report types ─────────────────────────
  const reportNames = new Set<string>();
  const dashboardNames = new Set<string>();
  let fieldsInReports = 0;
  let fieldsInDashboards = 0;
  let anyFoldCapHit = false;
  for (const field of fieldChildren) {
    const detail = reportDashboardUsageDetail(field);
    if (detail.usedInReport) fieldsInReports += 1;
    if (detail.usedInDashboard) fieldsInDashboards += 1;
    for (const n of detail.reportNames) reportNames.add(n);
    for (const n of detail.dashboardNames) dashboardNames.add(n);
    if (detail.reportsTruncatedTotal !== undefined || detail.dashboardsTruncatedTotal !== undefined) {
      anyFoldCapHit = true;
    }
  }
  /**
   * NAMES-vs-BOOLEAN: some vaults fold only the `usedInReport` BOOLEAN and no
   * `usedInReports` name array. Emitting `distinctReports: 0` beside a positive
   * `fieldsUsedInReports` was a self-contradiction that read as "zero reports".
   * When names are unavailable but the boolean count is positive, the count is
   * `null` with the reason and the remedy — never a counted zero.
   */
  const namesFolded = reportNames.size > 0 || fieldsInReports === 0;
  const dashboardNamesFolded = dashboardNames.size > 0 || fieldsInDashboards === 0;
  const reportsCapped = ledger.strings('analytics.reports', [...reportNames], cap);
  const dashboardsCapped = ledger.strings('analytics.dashboards', [...dashboardNames], cap);

  // ReportType edges land on the child FIELDS, not on the object node — an
  // object-level-only filter made this list structurally empty for EVERY object
  // while the field tier named ReportType referrers in the same response.
  const reportTypeIds = [
    ...new Set(
      [...objectUsageEdges, ...g.fieldInboundAll]
        .filter((e) => typeOf(e.fromId) === 'ReportType')
        .map((e) => e.fromId),
    ),
  ].sort(byIdAsc);
  const reportTypeObjectTier = new Set(
    objectUsageEdges.filter((e) => typeOf(e.fromId) === 'ReportType').map((e) => e.fromId),
  ).size;
  const reportNodeIds = [
    ...new Set(
      [...objectUsageEdges, ...g.fieldInboundAll]
        .filter((e) => e.fromId.startsWith('Report:'))
        .map((e) => e.fromId),
    ),
  ].sort(byIdAsc);
  const folderOf = (reportId: string): string => {
    const rest = reportId.slice('Report:'.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(0, slash) : 'unfiled';
  };
  const reportFolders = new Map<string, number>();
  for (const id of reportNodeIds) reportFolders.set(folderOf(id), (reportFolders.get(folderOf(id)) ?? 0) + 1);
  const reportNodeAvailability = familyAvailability(
    ctx,
    'Report',
    reportNodeIds.length,
    'no report references this object',
    'Run `sfi refresh --with-reports` for an uncapped reports pull; the default pull is usage-ranked and capped, and a vault built before Report nodes were persisted holds none at all.',
  );

  const analyticsSection = {
    fieldsUsedInReports: fieldsInReports,
    fieldsUsedInDashboards: fieldsInDashboards,
    distinctReports: namesFolded ? reportNames.size : null,
    reports: reportsCapped.shown,
    ...(reportsCapped.truncatedTotal !== undefined
      ? { reportsTruncatedTotal: reportsCapped.truncatedTotal }
      : {}),
    distinctDashboards: dashboardNamesFolded ? dashboardNames.size : null,
    dashboards: dashboardsCapped.shown,
    reportNameAvailability: namesFolded
      ? undefined
      : {
          reason:
            `${fieldsInReports} field(s) on this object carry the folded \`usedInReport\` BOOLEAN, but this vault ` +
            `folds no \`usedInReports\` NAME array, so WHICH reports they are cannot be listed. \`distinctReports\` ` +
            `is \`null\` — "not folded in this vault" — and must NOT be read as zero reports. Re-run ` +
            `\`sfi refresh --with-reports\` to populate the names.`,
        },
    reportTypes: {
      total: reportTypeIds.length,
      objectTierReferrers: reportTypeObjectTier,
      reportTypes: ledger.strings('analytics.reportTypes', reportTypeIds, cap).shown,
      note:
        'Collected from BOTH tiers. On the probe vault all 1,819 ReportType edges land on child `CustomField` ' +
        'nodes and NONE on a CustomObject, so an object-tier-only filter was structurally empty for every object ' +
        'while the same response named ReportType referrers under `usage.fieldLevel`.',
    },
    reportNodes: {
      total: reportNodeIds.length,
      byFolder: Object.fromEntries(
        [...reportFolders.entries()].sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0])),
      ),
      reports: ledger.strings('analytics.reportNodes.reports', reportNodeIds, cap).shown,
      availability: reportNodeAvailability,
      folderNote:
        'FOLDER comes from the `Report:{Folder}/{Name}` id. AUTHOR / owner / running user does NOT: the refresh ' +
        'excludes them as real usernames, so "who created the most reports" is a permanent offline boundary.',
    },
    foldNote:
      `${fieldsInReports} of this object's ${fieldChildren.length} field node(s) feed at least one report; ` +
      `${fieldsInDashboards} reach a dashboard. Composed from the per-FIELD usage the refresh already folds onto ` +
      `each CustomField — no report is re-parsed here.` +
      (anyFoldCapHit
        ? ' At least one field hit the fold-time 50-name cap, so the distinct-report count is a FLOOR, not an exact total.'
        : ''),
    caveat: REPORT_DASHBOARD_USAGE_CAVEAT,
  };

  // ── record data: asked, and refused, with the live tool named ────────────
  const recordDataSection = {
    recordCount: null,
    lastRecordCreated: null,
    lastRecordModified: null,
    topRecordOwner: null,
    topRecordCreator: null,
    fieldPopulation: null,
    everyValueIsNullBecause:
      'The vault holds METADATA. These are RECORD DATA, absent at any confidence — every null means NOT CHECKED, ' +
      'never zero and never "none". No refresh closes it.',
    answeredBy: {
      recordCount: 'sfi.live_count',
      lastRecordCreated: 'sfi.live_recent_activity',
      lastRecordModified: 'sfi.live_recent_activity',
      topRecordOwner: 'sfi.live_owner_breakdown',
      topRecordCreator: 'sfi.live_owner_breakdown',
      fieldPopulation: 'sfi.unused_fields_deep (with `objectId` + `liveEnabled: true`)',
    },
    liveNote: 'This tool never calls the live plane. Each named tool is read-only and consent-gated — enable with `sfi.live_consent`.',
  };

  // ── brief: the dated facts, with the detail behind each ──────────────────
  const objectLastModified =
    g.objectNode?.lastModifiedDate ?? stringProp(props, 'lastModifiedDate');
  const objectLastModifiedBy =
    g.objectNode?.lastModifiedBy ?? stringProp(props, 'lastModifiedBy');
  const datedChildren = g.children
    .map((c) => ({ id: c.id, date: c.lastModifiedDate ?? stringProp(c.properties, 'lastModifiedDate') }))
    .filter((c): c is { id: string; date: string } => c.date !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const mostRecentChild = datedChildren[0] ?? null;

  const lastMetadataChange = {
    scope: 'SCHEMA-DEFINITION',
    objectDefinition: {
      lastModifiedDate: objectLastModified,
      lastModifiedBy: objectLastModifiedBy,
      ...(objectLastModified === null
        ? {
            unavailableReason:
              'No `lastModifiedDate` on the object node in this vault. The Tooling-API enricher covers ApexClass, ' +
              'ApexTrigger, Flow, Layout, CustomField and ValidationRule — the CustomObject definition is NOT in ' +
              'that set, so even a fully-enriched vault can leave this null. Run `sfi refresh --with-tooling-api` ' +
              'for the types it does cover. `null` means NOT CAPTURED, never "never changed".',
          }
        : {}),
    },
    mostRecentAcrossOwnedComponents: mostRecentChild,
    datedOwnedComponents: datedChildren.length,
    undatedOwnedComponents: g.children.length - datedChildren.length,
    warning:
      'This dates a SCHEMA change — to the object\'s definition or to a component it owns. It is NOT activity and ' +
      'says nothing about records. A stale schema date is not "unused"; a fresh one is not "in use".',
  };

  const briefSection = {
    statement:
      `The offline picture of \`${apiName}\`: what it contains, what points at it, who can reach it, and when its ` +
      `metadata last changed. ANALYSIS, not a recommendation — nothing here is a blocker and no field says whether ` +
      `to keep, change or remove anything. Counts are exact over the vault; \`boundaries\` says what it cannot see.`,
    objectKind: objectKind.kind,
    ...(objectKind.namespace !== null ? { namespace: objectKind.namespace } : {}),
    lastMetadataChange,
    goesWithIt: {
      totalOwnedComponents: g.children.length,
      declaredFields: declaredFields.length,
      recordTypes: recordTypeChildren.length,
      validationRules: childCounts.get('ValidationRule') ?? 0,
      listViews: childCounts.get('ListView') ?? 0,
      layouts: layoutChildren.length,
      sharingRules: sharingRuleChildren.length,
      detailIn: 'owns',
    },
    pointsAtIt: {
      distinctReferrers: combinedReferrers.size,
      flowsBoundToObject: firesOnSave.find((r) => r.referrerType === 'Flow')?.count ?? 0,
      flowsBoundAndActive: firesOnSave.find((r) => r.referrerType === 'Flow')?.active ?? 0,
      apexTriggersBoundToObject:
        firesOnSave.find((r) => r.referrerType === 'ApexTrigger')?.count ?? 0,
      apexTriggersBoundAndActive:
        firesOnSave.find((r) => r.referrerType === 'ApexTrigger')?.active ?? 0,
      apexClassesReferencing: distinctReferrersOfType('ApexClass'),
      apexTriggersReferencing: distinctReferrersOfType('ApexTrigger'),
      relationshipFieldsFromOtherObjects: inboundRelationships.length,
      lightningRecordPages: flexiPageRows.length,
      detailIn: 'usage',
    },
    whoCanReachIt: {
      profilesGranted: profileGrants.size,
      profilesThatCanCreate: [...profileGrants.values()].filter((e) => e.properties['allowCreate'] === true).length,
      profilesThatCanEdit: [...profileGrants.values()].filter((e) => e.properties['allowEdit'] === true).length,
      profilesThatCanDelete: [...profileGrants.values()].filter((e) => e.properties['allowDelete'] === true).length,
      permissionSetsGranted: permsetGrants.size,
      detailIn: 'permissions',
    },
    recordActivity: {
      available: false,
      detailIn: 'recordData',
      note: 'Record counts, dates, owners and creators are RECORD DATA and are not in the vault — see `recordData` and `dataNotAvailable`.',
    },
  };

  // ── identity ─────────────────────────────────────────────────────────────
  const identitySection = {
    componentId: objectId,
    apiName,
    label: g.objectNode?.label ?? null,
    retrieved,
    objectKind: objectKind.kind,
    ...(objectKind.namespace !== null ? { namespace: objectKind.namespace } : {}),
    sharingModel: stringProp(props, 'sharingModel'),
    externalSharingModel: sharingSection.orgWideDefault.external,
    enableHistory: declaredFlag(props, 'enableHistory'),
    enableReports: declaredFlag(props, 'enableReports'),
    enableActivities: declaredFlag(props, 'enableActivities'),
    enableSearch: declaredFlag(props, 'enableSearch'),
    deploymentStatus: stringProp(props, 'deploymentStatus'),
    description: stringProp(props, 'description'),
    flagsNote:
      `The \`enable*\` flags (${AMBIGUOUS_FALSE_OBJECT_FLAGS.join(', ')}) are TRI-STATE: \`true\` when declared ` +
      `true, \`null\` otherwise, NEVER \`false\` — the extractor writes \`false\` for a declared \`false\` AND for ` +
      `an absent element, and the vault cannot tell them apart. A null \`enableReports\` does NOT mean the object ` +
      `cannot be reported on; see \`analytics\`.`,
    fields: {
      declared: declaredFields.length,
      synthetic: syntheticFields.length,
      total: fieldChildren.length,
      unresolvedReferencedTargets: g.unresolvedFieldTargets.size,
      note:
        `\`declared\` = fields extracted from real metadata. \`synthetic\` = platform/audit field NODES the refresh ` +
        `mints for standard objects so references resolve; no admin created them. \`unresolvedReferencedTargets\` = ` +
        `field ids edges point at with NO node here — counted in \`usage.fieldLevel\`, excluded from every TOTAL.`,
    },
    ...(retrieved
      ? {}
      : {
          notRetrievedNote:
            `\`${objectId}\` has NO node of its own in this vault: its definition was never retrieved (common for ` +
            `standard and managed-package objects). ` +
            (g.objectInbound.length > 0 || g.fieldInboundAll.length > 0
              ? `It IS referenced: ${objectUsageEdges.length} usage edge(s) plus ${objectGrantEdges.length} ` +
                `access grant(s) reach the object node, and ${g.fieldInboundAll.length} usage edge(s) reach its ` +
                `fields. Usage, automation and permission figures below are read from those edges (grants are ` +
                `reported under \`permissions\`, never as usage). `
              : `No edge reaches it either; only its ${g.children.length} owned component(s) place it here. `) +
            `The object's OWN properties (sharing model, description, history tracking) are UNAVAILABLE, not ` +
            `"false", and any field count below reflects only the field nodes this vault happens to hold` +
            (fieldChildren.length === 0
              ? ' — which is NONE for this object, so a zero field count means NOT RETRIEVED, never "no fields".'
              : '.'),
        }),
  };

  // ── honesty surfaces (always emitted, never section-filtered) ────────────
  const boundaries: string[] = [
    'This tool reports facts and does NOT adjudicate. No field in this response says whether a change or a deletion is safe, blocked or advisable — active automation, permission grants and existing records are consequences to weigh, not prohibitions.',
    'Usage is the set of MODELED incoming edges. String-BUILT dynamic SOQL, reflective `sObject.get()` / `Type.forName` dispatch, integration payloads naming the object only at runtime, and managed-package internals are invisible to static extraction — a small usage figure is never proof of disuse.',
    tierNote,
    'Absent is never `false` and empty is never "none". Edges pointing at un-noded field ids are counted and disclosed (`usage.fieldLevel.unresolvedNote`); `enable*` flags are tri-state (`identity.flagsNote`); `externalSharingModel` is never extracted (`sharing.orgWideDefault.external`); cross-object formula traversal is unresolved (`relationships.usedInFormulaFields.boundaryNote`); every family carries an `availability` note saying what its empty result means.',
    'Every date here is a SCHEMA change, never activity (`brief.lastMetadataChange.warning`). Record counts, dates, owners and creators are RECORD DATA — see `dataNotAvailable` for the live tool that answers each.',
    'Edge `confidence` differs by producer: object properties, relationship declarations and permission grants are `declared`; Apex-sourced edges are `parsed` (AST) or `heuristic`. This response is `mixed` — do not read a heuristic edge as a proven reference, or its absence as a proven non-reference.',
  ];
  const coverageCaveat: CoverageCaveat | undefined =
    objectUsageEdges.length === 0 && g.fieldInboundAll.length === 0
      ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE)
      : undefined;
  if (coverageCaveat !== undefined) boundaries.push(coverageCaveat.message);

  // A truncation disclosure for a section the caller filtered OUT would name a
  // list that is not in the response. Keep only the rows whose section shipped.
  const rolled = new Map<string, { lists: number; shown: number; total: number }>();
  for (const row of ledger.rows) {
    if (!wanted.has((row.section.split('.')[0] ?? '') as Object360Section)) continue;
    const key = row.section.split('.').slice(0, 2).join('.');
    const acc = rolled.get(key) ?? { lists: 0, shown: 0, total: 0 };
    acc.lists += 1;
    acc.shown += row.shown;
    acc.total += row.total;
    rolled.set(key, acc);
  }
  const shippedTruncation = [...rolled.entries()]
    .map(([section, acc]) => ({
      section,
      ...(acc.lists > 1 ? { cappedLists: acc.lists } : {}),
      shown: acc.shown,
      total: acc.total,
    }))
    .sort((a, b) => byIdAsc(a.section, b.section));

  const sections: Record<string, unknown> = {};
  if (wanted.has('identity')) sections['identity'] = identitySection;
  if (wanted.has('brief')) sections['brief'] = briefSection;
  if (wanted.has('owns')) sections['owns'] = ownsSection;
  if (wanted.has('usage')) sections['usage'] = usageSection;
  if (wanted.has('automations')) sections['automations'] = automationsSection;
  if (wanted.has('permissions')) sections['permissions'] = permissionsSection;
  if (wanted.has('relationships')) sections['relationships'] = relationshipsSection;
  if (wanted.has('recordTypes')) sections['recordTypes'] = recordTypesSection;
  if (wanted.has('sharing')) sections['sharing'] = sharingSection;
  if (wanted.has('recordPages')) sections['recordPages'] = recordPagesSection;
  if (wanted.has('analytics')) sections['analytics'] = analyticsSection;
  if (wanted.has('recordData')) sections['recordData'] = recordDataSection;

  const budgetTrimmed =
    effectiveCap < requestedCap || sampleCap < Math.max(1, Math.floor(requestedCap / 4));

  /**
   * The remedy that ACTUALLY works when the cap was refused.
   *
   * The old note answered a refused `maxRowsPerSection` by prescribing
   * `maxRowsPerSection` — the knob that had just been refused — so a caller who
   * followed it got a BYTE-IDENTICAL response and no way to tell the advice had
   * already failed. `includeSections` is the axis with headroom left: the same
   * byte budget spent on fewer sections buys the full row lists. Name the
   * sections that were actually cut hardest, as a call the caller can paste.
   */
  const heaviestCutSections = [
    ...new Set(
      [...shippedTruncation]
        .sort((a, b) => b.total - a.total || byIdAsc(a.section, b.section))
        .map((r) => r.section.split('.')[0] ?? '')
        .filter((name) => name !== ''),
    ),
  ].slice(0, 2);
  const remedySections =
    heaviestCutSections.length > 0 ? heaviestCutSections : [...wanted].sort(byIdAsc).slice(0, 1);
  /**
   * Narrowing has room left only while the caller is asking for MORE sections
   * than the remedy would name. Handing back the caller's own call as the
   * remedy is the same defect this note exists to fix, one axis over — so when
   * the narrowing axis is exhausted the note says that instead of prescribing.
   */
  const narrowingRoomLeft = wanted.size > remedySections.length;
  const remedyClause = narrowingRoomLeft
    ? `The remedy with budget left is \`includeSections\`: narrow to the sections you need and the same budget ` +
      `buys the FULL row lists — e.g. ` +
      `\`{"objectApiName":"${apiName}","includeSections":["${remedySections.join('","')}"],` +
      `"maxRowsPerSection":${MAX_ROWS_PER_SECTION_CAP}}\`.`
    : `\`includeSections\` has no room left either — this response is already narrowed to ` +
      `${wanted.size} section(s) and the row lists still do not fit. Nothing in this tool widens further; read ` +
      `the TRUE totals inline and reach for the tool that owns the specific question uncapped ` +
      `(\`sfi.object_access_audit\` for access, \`sfi.what_happens_on_save\` for automation).`;
  /**
   * Stated whenever the requested cap could not be honoured — with or without a
   * `truncation[]` index, because a caller who filtered every cut list out of
   * the response still needs to know the cap they passed was refused.
   */
  const rowsWereCut = effectiveCap < requestedCap;
  const refusedCapNote = budgetTrimmed
    ? `\`maxRowsPerSection: ${requestedCap}\`${scope.capWasExplicit ? '' : ' (the default)'} could NOT be ` +
      `honoured for \`${apiName}\`: the assembled response did not fit the ${BYTE_BUDGET}-byte budget, so ` +
      `referrer samples were cut to ${sampleCap}${rowsWereCut ? ` and row lists to ${effectiveCap}` : ''} ` +
      `(\`appliedScope.effectiveSampleCap\` / \`effectiveMaxRowsPerSection\`). ` +
      (rowsWereCut
        ? `RE-SENDING WITH A HIGHER \`maxRowsPerSection\` CANNOT CHANGE THIS RESPONSE: ${requestedCap} was ` +
          `itself tried and did not fit, and a larger cap only ever adds rows — ${effectiveCap} is the largest ` +
          `step on the fit ladder that fits. `
        : '') +
      `${remedyClause} Every capped list still reports its TRUE total inline ` +
      `(\`truncatedTotal\` / \`sampleTruncatedTotal\` / \`namesTotal\`), \`truncation[]\` is the rolled-up ` +
      `index (\`cappedLists\` = lists behind a row), and every AGGREGATE was computed over the FULL set BEFORE ` +
      `any cap.`
    : undefined;

  return {
    data: {
      appliedScope: {
        componentId: objectId,
        object: apiName,
        sections: [...wanted].sort(byIdAsc),
        maxRowsPerSection: requestedCap,
        ...(budgetTrimmed
          ? {
              effectiveMaxRowsPerSection: effectiveCap,
              effectiveSampleCap: sampleCap,
              maxRowsPerSectionHonoured: false,
              remedy: 'includeSections',
            }
          : {}),
        ...(scope.resolvedFrom !== null
          ? {
              resolvedFrom: scope.resolvedFrom,
              resolutionNote:
                `\`${scope.resolvedFrom}\` has no node here; Salesforce api names are CASE-INSENSITIVE, so it ` +
                `was resolved to \`${objectId}\` — the id every count below is about.`,
            }
          : {}),
      },
      ...sections,
      summary: {
        objectKind: objectKind.kind,
        declaredFields: declaredFields.length,
        ownedComponents: g.children.length,
        objectLevelUsageEdges: objectUsageEdges.length,
        fieldLevelUsageEdges: g.fieldInboundAll.length,
        distinctReferrers: combinedReferrers.size,
        activeAutomationBoundToObject: activeBound,
        profilesGranted: profileGrants.size,
        permissionSetsGranted: permsetGrants.size,
        recordTypes: recordTypeChildren.length,
        sharingRules: sharingRuleChildren.length,
        verdict: null,
        verdictNote:
          'There is no verdict: this tool analyses and never adjudicates. No field here is permission or prohibition.',
      },
      confidence: 'mixed',
      dataNotAvailable: OBJECT_360_DATA_NOT_AVAILABLE,
      boundaries,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(shippedTruncation.length > 0
        ? {
            truncated: true,
            truncation: shippedTruncation,
            truncationNote:
              refusedCapNote ??
              'Every capped list reports its TRUE total inline (`truncatedTotal` / `sampleTruncatedTotal` / ' +
                '`namesTotal`); `truncation[]` is the rolled-up index (`cappedLists` = lists behind a row). ' +
                'Every AGGREGATE is computed over the FULL set BEFORE capping. Raise `maxRowsPerSection` ' +
                '(max 100) or narrow with `includeSections`.',
          }
        : {
            truncated: false,
            ...(refusedCapNote !== undefined ? { truncationNote: refusedCapNote } : {}),
          }),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  };
};
