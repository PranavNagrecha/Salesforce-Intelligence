/**
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS.
 *
 * `sfi.crud_fls_audit` and `sfi.code_quality_audit` compose over the
 * `properties.qualityIssues[]` mirror. `detectCodeQualityIssues` ran from
 * `apex-class.ts` and nowhere else, so measured on a real vault:
 * **ApexClass 192/192 carried it, ApexTrigger 0 of 22, Flow 0 of 275** — while
 * both tools advertised walking "every ApexClass / ApexTrigger". A CRUD/FLS
 * audit of a trigger returned findings: [], boundaries: [], and nothing else.
 * Triggers are exactly where CRUD/FLS bugs live: a trigger does DML on
 * `Trigger.new` in system context by default.
 *
 * Two different absences, and they need two different answers:
 *
 *  1. **The trigger extractor now runs the recognizers.** But a vault built
 *     BEFORE that change holds trigger nodes with no `qualityIssues` key at
 *     all, and returns 0 findings for them forever. That is a gap a `sfi
 *     refresh` closes — {@link buildUnscannedNodesNote} says so by name, and
 *     the KEY's presence is what distinguishes it from a clean scan.
 *  2. **Flow is not Apex.** The 17 recognizers read Apex syntax — SOQL
 *     brackets, DML keywords, `Schema.sObjectType` guards. None of them can
 *     ever say anything about a Flow, on any vault, after any refresh. That is
 *     {@link NOT_APEX_TYPES}: named permanently, with a pointer at the tools
 *     that DO analyse flow quality, and removed from the scan list so the tools
 *     stop walking 275 nodes looking for a property that cannot exist.
 *
 * The distinction is the `coverageCaveat` / `unproducedEdgeType` distinction in
 * a different costume: (1) a refresh can close, (2) no refresh ever can.
 */

import type { ComponentType, Node } from '@sf-intelligence/contracts';

/** The node property the Apex quality recognizers write. */
export const QUALITY_ISSUES_PROPERTY = 'qualityIssues';

/** Per-type census of which nodes actually carry a quality scan. */
export interface QualityScanTypeCoverage {
  readonly type: ComponentType;
  /** Nodes of this type in the scanned set. */
  readonly nodes: number;
  /** Of those, how many carry the `qualityIssues` property at all. */
  readonly scanned: number;
}

/**
 * Census the nodes a quality-composing tool is about to read. A node counts as
 * `scanned` when it carries the `qualityIssues` KEY — an empty array is a clean
 * scan, an absent key is no scan at all, and the whole defect was treating
 * those two the same.
 */
export const censusQualityScanCoverage = (
  nodes: readonly Node[],
): readonly QualityScanTypeCoverage[] => {
  const byType = new Map<ComponentType, { nodes: number; scanned: number }>();
  for (const node of nodes) {
    const entry = byType.get(node.type) ?? { nodes: 0, scanned: 0 };
    entry.nodes += 1;
    if (Object.hasOwn(node.properties, QUALITY_ISSUES_PROPERTY)) {
      entry.scanned += 1;
    }
    byType.set(node.type, entry);
  }
  return [...byType.entries()]
    .map(([type, counts]) => ({ type, ...counts }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
};

/**
 * The refresh-closable half: nodes in THIS vault that were never scanned, named
 * with their type and count. `undefined` when every node carries a scan — in
 * which case nothing is emitted and the response is unchanged.
 */
export const buildUnscannedNodesNote = (
  coverage: readonly QualityScanTypeCoverage[],
): string | undefined => {
  const gaps = coverage.filter((c) => c.scanned < c.nodes);
  if (gaps.length === 0) return undefined;
  const named = gaps
    .map((c) => `${c.nodes - c.scanned} of ${c.nodes} ${c.type}`)
    .join(', ');
  return `NOT SCANNED IN THIS VAULT: ${named} node(s) carry no \`qualityIssues\` property, so the code-quality recognizers never ran over their source. Zero findings for them is "not checked", NOT "clean". This vault predates the extractor that scans them — re-run \`sfi refresh\` to close the gap.`;
};

/** A type the Apex recognizers can never say anything about, and why. */
export interface NotCheckedType {
  readonly type: ComponentType;
  readonly reason: string;
}

/**
 * Types a quality-composing tool structurally cannot cover, on any vault, after
 * any refresh — so they are named rather than scanned. `Flow` was listed in
 * `QUALITY_SCANNED_TYPES` and advertised as covered while contributing exactly
 * zero of 275 nodes, because the recognizers read Apex syntax and a Flow has
 * none.
 */
export const NOT_APEX_TYPES: readonly NotCheckedType[] = [
  {
    type: 'Flow',
    reason:
      'Flow is not Apex. Every code-quality recognizer reads Apex syntax (inline SOQL brackets, DML statements, `Schema.sObjectType` guards, sharing keywords), so none of them can produce a finding for a Flow on any vault after any refresh — this is not a coverage gap a refresh closes. Flow-side equivalents live in their own tools: `sfi.flow_bulkification_audit` (DML / Get Records inside a Loop, filterless Get Records), `sfi.flow_fault_audit` (unhandled fault paths) and `sfi.explain_flow`.',
  },
];

/** The verbatim boundary naming the types that were deliberately not scanned. */
export const buildNotCheckedTypesNote = (
  notChecked: readonly NotCheckedType[],
): string | undefined => {
  if (notChecked.length === 0) return undefined;
  return `NOT CHECKED BY DESIGN — ${notChecked
    .map((n) => `${n.type}: ${n.reason}`)
    .join(' ')}`;
};

/**
 * A governor limit this tool never examines, and why. The `reason` splits the
 * same two ways the type census above does: a RUNTIME-only limit (heap, CPU,
 * row counts) is a gap no `sfi refresh` can ever close, while "no static
 * recognizer ships for X" is a gap a future recognizer closes.
 */
export interface NotCheckedLimit {
  /** Human-readable governor-limit name, as Salesforce names it. */
  readonly limit: string;
  /** Why this tool cannot say anything about it. */
  readonly reason: string;
}

/**
 * D-3 applied to the LIMIT axis. `sfi.governor_limit_risks` is named for
 * governor limits and models exactly three static loop recognizers
 * (`soql-in-loop`, `dml-in-loop`, `database-upsert-no-options`). Every other
 * governor limit is never examined — so `totalRiskCount: 0` was an UNCHECKED
 * zero for all of them, on the tool whose name promises otherwise. Naming them
 * is what makes the zero readable as CHECKED (for the three) and UNCHECKED
 * (for these).
 */
export const NOT_CHECKED_GOVERNOR_LIMITS: readonly NotCheckedLimit[] = [
  {
    limit: 'heap size',
    reason:
      'requires runtime allocation data; not derivable from static source',
  },
  {
    limit: 'Apex CPU time',
    reason: 'requires runtime timing; not derivable from static source',
  },
  {
    limit: 'callouts',
    reason: 'no static recognizer ships for callout-in-loop',
  },
  {
    limit: 'query rows',
    reason:
      'requires record volume; the vault holds metadata, never record data',
  },
  {
    limit: 'DML rows',
    reason:
      'requires record volume; the vault holds metadata, never record data',
  },
  {
    limit: 'future / queueable invocations',
    reason: 'no static recognizer ships for async-dispatch-in-loop',
  },
  {
    limit: 'email invocations',
    reason: 'no static recognizer ships for email-in-loop',
  },
];

/**
 * The verbatim boundary naming the governor limits that were NOT examined.
 * `undefined` for an empty list, mirroring {@link buildNotCheckedTypesNote}, so
 * a caller can push the result without a second emptiness check.
 */
export const buildNotCheckedLimitsNote = (
  notChecked: readonly NotCheckedLimit[],
): string | undefined => {
  if (notChecked.length === 0) return undefined;
  const named = notChecked.map((n) => n.limit).join(', ');
  return `NOT CHECKED — this tool models three static loop recognizers (soql-in-loop, dml-in-loop, database-upsert-no-options). The following governor limits were NOT examined and a zero here says nothing about them: ${named}. Some are runtime-only and no refresh can close them; for a RUNTIME limit that actually fired, use sfi.explain_debug_log.`;
};
